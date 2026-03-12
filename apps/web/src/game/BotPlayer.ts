import type { Client, Room } from '@colyseus/sdk';
import type { InputState } from '@tankbet/game-engine/physics';
import type { SeatReservation } from './GameEngine';
import type { TankRoomState } from '@tankbet/game-engine/schema';

/**
 * Headless bot that joins a Colyseus room as a second player and sends
 * randomized movement/fire inputs. Does not render anything — purely
 * network interaction for dev/test purposes.
 */
export class BotPlayer {
  private room: Room<TankRoomState> | null = null;
  private inputInterval: ReturnType<typeof setInterval> | null = null;
  private directionTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private clientTick = 0;
  private currentInput: InputState = { up: false, down: false, left: false, right: false, fire: false };
  private onStatusChange: ((status: string) => void) | null = null;

  setStatusCallback(cb: (status: string) => void): void {
    this.onStatusChange = cb;
  }

  async connect(client: Client, seatReservation: SeatReservation): Promise<void> {
    this.room = await client.consumeSeatReservation<TankRoomState>(seatReservation);
    this.onStatusChange?.('connected');

    // Ping/pong for RTT: client sends 'ping' → server responds with 'pong'
    // → client computes RTT and sends 'rtt' back to server.
    this.room.onMessage('pong', (data: { clientTime: number }) => {
      const rtt = performance.now() - data.clientTime;
      this.room?.send('rtt', { rtt });
    });

    this.room.send('ping', { clientTime: performance.now() });
    this.pingInterval = setInterval(() => {
      this.room?.send('ping', { clientTime: performance.now() });
    }, 2000);

    this.room.onLeave(() => {
      this.onStatusChange?.('disconnected');
      this.stopLoops();
    });

    this.startInputLoop();
    this.pickNewDirection();
  }

  private stopLoops(): void {
    this.stopInputLoop();
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private startInputLoop(): void {
    // Send current input state every 100ms
    this.inputInterval = setInterval(() => {
      if (!this.room) return;
      this.clientTick++;

      // Fire ~16% of ticks (every ~625ms on average)
      const shouldFire = Math.random() < 0.16;
      const inputToSend: InputState = { ...this.currentInput, fire: shouldFire };

      this.room.send('input', { keys: inputToSend, tick: this.clientTick });
    }, 100);
  }

  private pickNewDirection(): void {
    // Pick a random movement direction (or idle)
    const directions: Array<Partial<Record<'up' | 'down' | 'left' | 'right', boolean>>> = [
      { up: true },
      { down: true },
      { left: true },
      { right: true },
      { up: true, left: true },
      { up: true, right: true },
      { down: true, left: true },
      { down: true, right: true },
      {}, // idle
    ];

    const choice = directions[Math.floor(Math.random() * directions.length)];
    this.currentInput = {
      up: choice.up ?? false,
      down: choice.down ?? false,
      left: choice.left ?? false,
      right: choice.right ?? false,
      fire: false,
    };

    // Hold this direction for 0.5–2s before switching
    const holdMs = 500 + Math.random() * 1500;
    this.directionTimeout = setTimeout(() => {
      this.pickNewDirection();
    }, holdMs);
  }

  private stopInputLoop(): void {
    if (this.inputInterval !== null) {
      clearInterval(this.inputInterval);
      this.inputInterval = null;
    }
    if (this.directionTimeout !== null) {
      clearTimeout(this.directionTimeout);
      this.directionTimeout = null;
    }
  }

  disconnect(): void {
    this.stopLoops();
    if (this.room) {
      void this.room.leave();
      this.room = null;
    }
    this.onStatusChange?.('disconnected');
  }
}
