import type { Client, Room } from '@colyseus/sdk';
import type { InputState, TankState, BulletState, MissileState } from '@tankbet/game-engine/physics';
import { shortestAngleDelta } from '@tankbet/game-engine/physics';
import type { LineSegment } from '@tankbet/game-engine/maze';
import type { ActiveEffectData } from '@tankbet/game-engine/powerups';
import { INTERPOLATION_DELAY_MS } from '@tankbet/game-engine/constants';
import {
  clearCanvas,
  drawMaze,
  drawTank,
  drawBullet,
  drawMissile,
  drawPowerup,
  drawTankPowerupIndicator,
  drawCountdown,
  drawHUD,
  drawExplosion,
  EXPLOSION_DURATION_MS,
} from '@tankbet/game-engine/renderer';
import { TankRoomState } from '@tankbet/game-engine/schema';
import { InputHandler } from './InputHandler';

interface ClientTankState {
  id: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  alive: boolean;
  effects: ActiveEffectData[];
}

interface PowerupSnapshot {
  id: string;
  type: string;
  x: number;
  y: number;
}

interface SnapshotState {
  tanks: Map<string, ClientTankState>;
  bullets: BulletState[];
  missiles: MissileState[];
  powerups: PowerupSnapshot[];
  countdown: number;
  phase: string;
  winnerId: string;
  roundWinnerId: string;
  lives: Map<string, number>;
}

interface SnapshotEntry {
  timestamp: number;
  state: SnapshotState;
}

// Flat seat reservation shape from @colyseus/core 0.17 matchMaker.reserveSeatFor
export interface SeatReservation {
  sessionId: string;
  roomId: string;
  name: string;
  processId: string;
  publicAddress?: string;
}

export class GameEngine {
  private client: Client | null = null;
  private room: Room | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private inputHandler: InputHandler;
  private stateBuffer: SnapshotEntry[] = [];
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
  private prevTankAlive = new Map<string, boolean>();

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

    this.room = await this.client.consumeSeatReservation<TankRoomState>(seatReservation);
    this.localSessionId = this.room.sessionId;

    this.room.onMessage('maze', (data: { segments: LineSegment[] }) => {
      console.log(`[GameEngine] received maze: ${data.segments.length} segments`);
      this.setMazeSegments(data.segments);
    });

    this.room.onStateChange((state: TankRoomState) => {
      console.log(`[GameEngine] onStateChange phase=${state.phase} countdown=${state.countdown} tanks=${state.tanks.size}`);
      const snapshot = this.parseState(state);

      // Detect alive → dead transitions and spawn explosions
      snapshot.tanks.forEach((tank, sessionId) => {
        const wasAlive = this.prevTankAlive.get(sessionId);
        if (wasAlive === true && !tank.alive) {
          this.explosions.push({ x: tank.x, y: tank.y, startTime: Date.now() });
        }
        this.prevTankAlive.set(sessionId, tank.alive);
      });

      this.stateBuffer.push({ timestamp: Date.now(), state: snapshot });

      if (this.stateBuffer.length > 60) {
        this.stateBuffer = this.stateBuffer.slice(-30);
      }

      if (this.onPhaseChange) {
        this.onPhaseChange(snapshot.phase, snapshot.winnerId, snapshot.roundWinnerId);
      }
    });

    this.inputHandler.attach(this.playerIndex, (keys: InputState, seq: number) => {
      this.room?.send('input', { keys, seq });
    });

    this.startRenderLoop();
  }

  private parseState(state: TankRoomState): SnapshotState {
    const tanks = new Map<string, ClientTankState>();
    state.tanks.forEach((t, key) => {
      const effects: ActiveEffectData[] = [];
      t.effects.forEach((e) => {
        effects.push({
          type: e.type,
          remainingTime: e.remainingTime,
          remainingAmmo: e.remainingAmmo,
        });
      });
      tanks.set(key, {
        id: t.id,
        x: t.x,
        y: t.y,
        angle: t.angle,
        speed: 0,
        alive: t.alive,
        effects,
      });
    });

    const bullets: BulletState[] = [];
    state.bullets.forEach((b) => {
      bullets.push({
        id: b.id,
        ownerId: b.ownerId,
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy,
        age: 0,
      });
    });

    const missiles: MissileState[] = [];
    state.missiles.forEach((m) => {
      missiles.push({
        id: m.id,
        ownerId: m.ownerId,
        x: m.x,
        y: m.y,
        vx: m.vx,
        vy: m.vy,
        age: m.age,
        initialTargetId: '',
      });
    });

    const powerups: PowerupSnapshot[] = [];
    state.powerups.forEach((p) => {
      powerups.push({
        id: p.id,
        type: p.type,
        x: p.x,
        y: p.y,
      });
    });

    const lives = new Map<string, number>();
    state.lives.forEach((v, k) => {
      lives.set(k, v);
    });

    return {
      tanks,
      bullets,
      missiles,
      powerups,
      countdown: state.countdown,
      phase: state.phase,
      winnerId: state.winnerId,
      roundWinnerId: state.roundWinnerId,
      lives,
    };
  }

  private startRenderLoop(): void {
    const render = (): void => {
      this.draw();
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  private getInterpolatedState(): SnapshotState | null {
    if (this.stateBuffer.length === 0) return null;

    const renderTime = Date.now() - INTERPOLATION_DELAY_MS;

    let before: SnapshotEntry | null = null;
    let after: SnapshotEntry | null = null;

    for (let i = 0; i < this.stateBuffer.length; i++) {
      if (this.stateBuffer[i].timestamp <= renderTime) {
        before = this.stateBuffer[i];
      } else {
        after = this.stateBuffer[i];
        break;
      }
    }

    // Bullets: extrapolate from the most recent snapshot using velocity.
    // Bullet velocity is constant between wall bounces, so x += vx*dt is accurate
    // at any frame rate and avoids the interpolation stutter visible at 20–30Hz.
    const bulletRef = after ?? before;
    const bullets: BulletState[] = bulletRef
      ? bulletRef.state.bullets.map((b) => {
          const dt = (renderTime - bulletRef.timestamp) / 1000;
          return { ...b, x: b.x + b.vx * dt, y: b.y + b.vy * dt };
        })
      : [];

    // No bracketing snapshots — return latest state with extrapolated bullets.
    if (!before || !after) {
      const fallback = this.stateBuffer[this.stateBuffer.length - 1].state;
      return { ...fallback, bullets };
    }

    const total = after.timestamp - before.timestamp;
    const elapsed = renderTime - before.timestamp;
    const t = total > 0 ? Math.min(elapsed / total, 1) : 0;

    const tanks = new Map<string, ClientTankState>();
    before.state.tanks.forEach((bTank, key) => {
      const aTank = after.state.tanks.get(key);
      if (aTank) {
        tanks.set(key, {
          id: bTank.id,
          x: bTank.x + (aTank.x - bTank.x) * t,
          y: bTank.y + (aTank.y - bTank.y) * t,
          angle: bTank.angle + shortestAngleDelta(aTank.angle, bTank.angle) * t,
          speed: aTank.speed,
          alive: aTank.alive,
          effects: aTank.effects,
        });
      } else {
        tanks.set(key, bTank);
      }
    });

    const missiles: MissileState[] = after.state.missiles.map((aMissile) => {
      const bMissile = before.state.missiles.find((m) => m.id === aMissile.id);
      if (bMissile) {
        return {
          id: aMissile.id,
          ownerId: aMissile.ownerId,
          x: bMissile.x + (aMissile.x - bMissile.x) * t,
          y: bMissile.y + (aMissile.y - bMissile.y) * t,
          vx: aMissile.vx,
          vy: aMissile.vy,
          age: aMissile.age,
          initialTargetId: aMissile.initialTargetId,
        };
      }
      return aMissile;
    });

    return {
      tanks,
      bullets,
      missiles,
      powerups: after.state.powerups,
      countdown: after.state.countdown,
      phase: after.state.phase,
      winnerId: after.state.winnerId,
      roundWinnerId: after.state.roundWinnerId,
      lives: after.state.lives,
    };
  }

  private draw(): void {
    const { width, height } = this.canvas;
    clearCanvas(this.ctx, width, height);

    if (this.mazeSegments.length > 0) {
      drawMaze(this.ctx, this.mazeSegments);
    }

    const now = Date.now();
    const state = this.getInterpolatedState();
    if (!state) return;

    // Client-side prediction disabled: tank position is authoritative from the server.
    // Previously the local prediction ran updateTank without wall collision, causing
    // the tank to visually phase through walls before the server correction caught up.

    for (const powerup of state.powerups) {
      drawPowerup(this.ctx, powerup, now);
    }

    const tankColors = ['#4ade80', '#f87171'];
    let colorIdx = 0;
    state.tanks.forEach((tank) => {
      const color = tankColors[colorIdx % 2];
      colorIdx++;
      if (!tank.alive) return;
      const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: tank.speed };
      drawTank(this.ctx, ts, color);
      drawTankPowerupIndicator(this.ctx, tank, tank.effects, now);
    });

    for (const bullet of state.bullets) {
      drawBullet(this.ctx, bullet);
    }

    for (const missile of state.missiles) {
      drawMissile(this.ctx, missile);
    }

    // Draw and prune expired explosions
    this.explosions = this.explosions.filter((exp) => now - exp.startTime < EXPLOSION_DURATION_MS);
    for (const exp of this.explosions) {
      drawExplosion(this.ctx, exp.x, exp.y, now - exp.startTime);
    }

    if (!this.isPractice) {
      const livesArr = Array.from(state.lives.values());
      const p1Lives = livesArr[0] ?? 0;
      const p2Lives = livesArr[1] ?? 0;
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

    if (state.phase === 'countdown') {
      drawCountdown(this.ctx, width, height, state.countdown);
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
