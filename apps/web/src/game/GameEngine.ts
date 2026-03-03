import type { Room } from '@colyseus/sdk';
import { getStateCallbacks } from '@colyseus/sdk';
import type { Client } from '@colyseus/sdk';
import type { InputState, TankState } from '@tankbet/game-engine/physics';
import {
  shortestAngleDelta,
} from '@tankbet/game-engine/physics';
import type { LineSegment } from '@tankbet/game-engine/maze';
import {
  clearCanvas,
  drawMaze,
  drawTank,
  drawBullet,
  drawCountdown,
  drawHUD,
  drawExplosion,
  EXPLOSION_DURATION_MS,
} from '@tankbet/game-engine/renderer';
import type { TankRoomState, Bullet } from '@tankbet/game-engine/schema';
import { InputHandler } from './InputHandler';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface RemoteTankState {
  x: number;
  y: number;
  angle: number;
  speed: number;
  prevX: number;
  prevY: number;
  prevAngle: number;
  targetX: number;
  targetY: number;
  targetAngle: number;
  targetSpeed: number;
  lastUpdateTime: number;
  updateInterval: number;
}

// Bullet interpolation state (same pattern as tank interpolation)
interface RemoteBulletState {
  x: number;
  y: number;
  ownerId: string;
  prevX: number;
  prevY: number;
  targetX: number;
  targetY: number;
  lastUpdateTime: number;
  updateInterval: number;
}

// Flat seat reservation shape from @colyseus/core 0.17 matchMaker.reserveSeatFor
export interface SeatReservation {
  sessionId: string;
  roomId: string;
  name: string;
  processId: string;
  publicAddress?: string;
}

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// GameEngine
// ---------------------------------------------------------------------------

export class GameEngine {
  private client: Client | null = null;
  private room: Room<TankRoomState> | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private inputHandler: InputHandler;
  private mazeSegments: LineSegment[] = [];
  private animFrameId: number | null = null;
  private playerIndex: 0 | 1 = 0;
  private player1Name = '';
  private player2Name = '';
  private betAmountCents = 0;

  private onPhaseChange: ((phase: string, winnerId: string, roundWinnerId: string) => void) | null = null;
  private localSessionId = '';
  private isPractice = false;
  private explosions: Array<{ x: number; y: number; startTime: number }> = [];

  // Tank interpolation (all tanks, including local)
  private remoteTanks = new Map<string, RemoteTankState>();

  // Bullet interpolation (schema-driven)
  private remoteBullets = new Map<string, RemoteBulletState>();

  // Game state tracking (replaces parseState/stateBuffer)
  private currentPhase = 'waiting';
  private currentCountdown = 0;
  private currentWinnerId = '';
  private currentRoundWinnerId = '';
  private currentLives = new Map<string, number>();
  private tankAliveState = new Map<string, boolean>();

  // Track session ID insertion order for color assignment
  private tankSessionOrder: string[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context');
    this.ctx = ctx;
    this.inputHandler = new InputHandler();
  }

  setPhaseChangeCallback(cb: (phase: string, winnerId: string, roundWinnerId: string) => void): void {
    this.onPhaseChange = cb;
  }

  async connect(
    colyseusClient: Client,
    seatReservation: SeatReservation,
    playerIndex: 0 | 1,
    player1Name: string,
    player2Name: string,
    betAmountCents: number,
    practice = false,
  ): Promise<void> {
    this.client = colyseusClient;
    this.playerIndex = playerIndex;
    this.player1Name = player1Name;
    this.player2Name = player2Name;
    this.betAmountCents = betAmountCents;
    this.isPractice = practice;

    const room = await this.client.consumeSeatReservation<TankRoomState>(seatReservation);
    this.room = room;
    this.localSessionId = room.sessionId;

    // -----------------------------------------------------------------------
    // Maze message
    // -----------------------------------------------------------------------
    room.onMessage('maze', (data: { segments: LineSegment[] }) => {
      console.log(`[GameEngine] received maze: ${data.segments.length} segments`);
      this.setMazeSegments(data.segments);
    });

    // -----------------------------------------------------------------------
    // Schema callback proxy
    // -----------------------------------------------------------------------
    const getCallbacks = getStateCallbacks(room);
    if (!getCallbacks) throw new Error('Failed to get state callbacks');
    const $ = getCallbacks(room.state);

    // -----------------------------------------------------------------------
    // Tank schema callbacks
    // -----------------------------------------------------------------------
    $.tanks.onAdd((tank, sessionId) => {
      // Track insertion order for color assignment
      if (!this.tankSessionOrder.includes(sessionId)) {
        this.tankSessionOrder.push(sessionId);
      }

      // All tanks (local + remote) use the same interpolation path
      this.remoteTanks.set(sessionId, {
        x: tank.x,
        y: tank.y,
        angle: tank.angle,
        speed: tank.speed,
        prevX: tank.x,
        prevY: tank.y,
        prevAngle: tank.angle,
        targetX: tank.x,
        targetY: tank.y,
        targetAngle: tank.angle,
        targetSpeed: tank.speed,
        lastUpdateTime: performance.now(),
        updateInterval: 10, // initial guess (1000/100)
      });

      this.tankAliveState.set(sessionId, tank.alive);

      // Per-instance change listener — fires when ANY property on this tank changes
      const tankProxy = getCallbacks(tank);
      tankProxy.onChange(() => {
        // Detect alive state transitions
        const wasAlive = this.tankAliveState.get(sessionId);
        if (wasAlive === true && !tank.alive) {
          this.explosions.push({ x: tank.x, y: tank.y, startTime: Date.now() });
        }

        // Detect dead -> alive (respawn): snap interpolation to new position
        const isRespawn = wasAlive === false && tank.alive;
        this.tankAliveState.set(sessionId, tank.alive);

        // Update interpolation targets (same path for local + remote)
        const remote = this.remoteTanks.get(sessionId);
        if (remote) {
          if (isRespawn) {
            // Snap directly to respawn position — no lerp from death location
            remote.x = tank.x;
            remote.y = tank.y;
            remote.angle = tank.angle;
            remote.speed = tank.speed;
            remote.prevX = tank.x;
            remote.prevY = tank.y;
            remote.prevAngle = tank.angle;
            remote.targetX = tank.x;
            remote.targetY = tank.y;
            remote.targetAngle = tank.angle;
            remote.targetSpeed = tank.speed;
            remote.lastUpdateTime = performance.now();
          } else {
            const now = performance.now();
            const elapsed = now - remote.lastUpdateTime;
            // Adaptive update interval (EMA)
            if (elapsed > 0 && elapsed < 200) {
              remote.updateInterval = remote.updateInterval * 0.7 + elapsed * 0.3;
            }
            // Shift previous target to prev
            remote.prevX = remote.targetX;
            remote.prevY = remote.targetY;
            remote.prevAngle = remote.targetAngle;
            // Set new target
            remote.targetX = tank.x;
            remote.targetY = tank.y;
            remote.targetAngle = tank.angle;
            remote.targetSpeed = tank.speed;
            remote.lastUpdateTime = now;
          }
        }
      });
    });

    $.tanks.onRemove((_tank, sessionId) => {
      this.remoteTanks.delete(sessionId);
      this.tankAliveState.delete(sessionId);
    });

    // -----------------------------------------------------------------------
    // Bullet schema callbacks
    // -----------------------------------------------------------------------
    $.bullets.onAdd((bullet: Bullet, bulletId: string) => {
      this.remoteBullets.set(bulletId, {
        x: bullet.x,
        y: bullet.y,
        ownerId: bullet.ownerId,
        prevX: bullet.x,
        prevY: bullet.y,
        targetX: bullet.x,
        targetY: bullet.y,
        lastUpdateTime: performance.now(),
        updateInterval: 10,
      });

      const bulletProxy = getCallbacks(bullet);
      bulletProxy.onChange(() => {
        const remote = this.remoteBullets.get(bulletId);
        if (remote) {
          const now = performance.now();
          const elapsed = now - remote.lastUpdateTime;
          if (elapsed > 0 && elapsed < 200) {
            remote.updateInterval = remote.updateInterval * 0.7 + elapsed * 0.3;
          }
          remote.prevX = remote.targetX;
          remote.prevY = remote.targetY;
          remote.targetX = bullet.x;
          remote.targetY = bullet.y;
          remote.lastUpdateTime = now;
        }
      });
    });

    $.bullets.onRemove((_bullet: Bullet, bulletId: string) => {
      this.remoteBullets.delete(bulletId);
    });

    // -----------------------------------------------------------------------
    // Lives callbacks
    // -----------------------------------------------------------------------
    $.lives.onAdd((value, sessionId) => {
      this.currentLives.set(sessionId, value);
    });

    $.lives.onChange((value, sessionId) => {
      this.currentLives.set(sessionId, value);
    });

    $.lives.onRemove((_value, sessionId) => {
      this.currentLives.delete(sessionId);
    });

    // -----------------------------------------------------------------------
    // Scalar field listeners
    // -----------------------------------------------------------------------
    $.listen('phase', (value) => {
      this.currentPhase = value;
      this.notifyPhaseChange();
    });

    $.listen('countdown', (value) => {
      this.currentCountdown = value;
    });

    $.listen('winnerId', (value) => {
      this.currentWinnerId = value;
      this.notifyPhaseChange();
    });

    $.listen('roundWinnerId', (value) => {
      this.currentRoundWinnerId = value;
      this.notifyPhaseChange();
    });

    // -----------------------------------------------------------------------
    // Input handler — sends to server on key state changes only
    // -----------------------------------------------------------------------
    this.inputHandler.attach(this.playerIndex, (keys: InputState) => {
      this.room?.send('input', { keys });
    });

    this.startRenderLoop();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private notifyPhaseChange(): void {
    if (this.onPhaseChange) {
      this.onPhaseChange(this.currentPhase, this.currentWinnerId, this.currentRoundWinnerId);
    }
  }

  // -------------------------------------------------------------------------
  // Interpolate remote tanks
  // -------------------------------------------------------------------------

  private interpolateRemoteTanks(): void {
    const now = performance.now();
    this.remoteTanks.forEach((remote) => {
      const elapsed = now - remote.lastUpdateTime;
      const t = Math.min(elapsed / remote.updateInterval, 2.0);
      const tClamped = Math.min(t, 1.0);

      // Lerp from prev to target
      remote.x = remote.prevX + (remote.targetX - remote.prevX) * tClamped;
      remote.y = remote.prevY + (remote.targetY - remote.prevY) * tClamped;

      // Use shortestAngleDelta for angle interpolation
      const angleDelta = shortestAngleDelta(remote.targetAngle, remote.prevAngle);
      remote.angle = remote.prevAngle + angleDelta * tClamped;

      remote.speed = remote.targetSpeed;
    });
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  private startRenderLoop(): void {
    const render = (): void => {
      this.draw();
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  private draw(): void {
    const { width, height } = this.canvas;
    clearCanvas(this.ctx, width, height);

    if (this.mazeSegments.length > 0) {
      drawMaze(this.ctx, this.mazeSegments);
    }

    const now = Date.now();
    const perfNow = performance.now();

    // Interpolate all tanks (local + remote)
    this.interpolateRemoteTanks();

    // Draw all tanks uniformly
    const tankColors = ['#4ade80', '#f87171'];

    this.remoteTanks.forEach((remote, sessionId) => {
      const alive = this.tankAliveState.get(sessionId);
      if (!alive) return;
      const orderIdx = this.tankSessionOrder.indexOf(sessionId);
      const color = tankColors[orderIdx >= 0 ? orderIdx % 2 : 0];
      const ts: TankState = { id: sessionId, x: remote.x, y: remote.y, angle: remote.angle, speed: remote.speed };
      drawTank(this.ctx, ts, color);
    });

    // Draw bullets with interpolation between schema updates
    this.remoteBullets.forEach((remote) => {
      const elapsed = perfNow - remote.lastUpdateTime;
      const t = Math.min(elapsed / remote.updateInterval, 1.0);
      const x = remote.prevX + (remote.targetX - remote.prevX) * t;
      const y = remote.prevY + (remote.targetY - remote.prevY) * t;
      drawBullet(this.ctx, { id: '', ownerId: remote.ownerId, x, y, vx: 0, vy: 0, age: 0 });
    });

    // Draw and prune expired explosions
    this.explosions = this.explosions.filter((exp) => now - exp.startTime < EXPLOSION_DURATION_MS);
    for (const exp of this.explosions) {
      drawExplosion(this.ctx, exp.x, exp.y, now - exp.startTime);
    }

    // HUD
    const p1SessionId = this.tankSessionOrder[0] ?? '';
    const p2SessionId = this.tankSessionOrder[1] ?? '';

    if (this.isPractice) {
      drawHUD(this.ctx, width, height, '', '', 0, 0, 0);
    } else {
      const p1Lives = this.currentLives.get(p1SessionId) ?? 0;
      const p2Lives = this.currentLives.get(p2SessionId) ?? 0;
      drawHUD(
        this.ctx,
        width,
        height,
        this.player1Name,
        this.player2Name,
        p1Lives,
        p2Lives,
        this.betAmountCents,
      );
    }

    if (this.currentPhase === 'countdown') {
      drawCountdown(this.ctx, width, height, this.currentCountdown);
    }
  }

  setMazeSegments(segments: LineSegment[]): void {
    this.mazeSegments = segments;
  }

  forfeit(): void {
    this.room?.send('forfeit');
    this.destroy();
  }

  destroy(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
    this.inputHandler.detach();
    void this.room?.leave();
    this.room = null;
    this.client = null;
  }
}
