import type { Client, Room } from 'colyseus.js';

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function iterateMap(schema: unknown, cb: (value: Record<string, unknown>, key: string) => void): void {
  if (!schema || typeof schema !== 'object' || !('forEach' in schema)) return;
  (schema as { forEach: (cb: (v: unknown, k: string) => void) => void }).forEach((v, k) => {
    if (v && typeof v === 'object') cb(v as Record<string, unknown>, k);
  });
}

function iterateArray(schema: unknown, cb: (value: Record<string, unknown>) => void): void {
  if (!Array.isArray(schema) && !(schema && typeof schema === 'object' && 'forEach' in schema)) return;
  if (Array.isArray(schema)) {
    for (const item of schema) {
      if (item && typeof item === 'object') cb(item as Record<string, unknown>);
    }
  } else {
    (schema as { forEach: (cb: (v: unknown) => void) => void }).forEach((v) => {
      if (v && typeof v === 'object') cb(v as Record<string, unknown>);
    });
  }
}
import type { InputState, TankState, BulletState, MissileState } from '@tankbet/game-engine/physics';
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
} from '@tankbet/game-engine/renderer';
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
  lives: Map<string, number>;
}

interface SnapshotEntry {
  timestamp: number;
  state: SnapshotState;
}

// Minimal type for the seat reservation returned by the server via matchMaker.reserveSeatFor.
// consumeSeatReservation() accepts `any`, but we type it for clarity.
export interface SeatReservation {
  sessionId: string;
  room: { roomId: string; [key: string]: unknown };
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

  private onPhaseChange: ((phase: string, winnerId: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context');
    this.ctx = ctx;
    this.inputHandler = new InputHandler();
  }

  setPhaseChangeCallback(cb: (phase: string, winnerId: string) => void): void {
    this.onPhaseChange = cb;
  }

  async connect(
    colyseusClient: Client,
    seatReservation: SeatReservation,
    playerIndex: 0 | 1,
    player1Name: string,
    player2Name: string,
    betAmountCents: number,
  ): Promise<void> {
    this.client = colyseusClient;
    this.playerIndex = playerIndex;
    this.player1Name = player1Name;
    this.player2Name = player2Name;
    this.betAmountCents = betAmountCents;

    this.room = await this.client.consumeSeatReservation(seatReservation);

    this.room.onMessage('maze', (data: { segments: LineSegment[] }) => {
      console.log(`[GameEngine] received maze: ${data.segments.length} segments`);
      this.setMazeSegments(data.segments);
    });

    this.room.onStateChange((state: Record<string, unknown>) => {
      const rawPhase = state['phase'];
      const rawCountdown = state['countdown'];
      const rawTanks = state['tanks'];
      const tankCount = rawTanks && typeof rawTanks === 'object' && 'size' in rawTanks ? (rawTanks as { size: number }).size : '?';
      console.log(`[GameEngine] onStateChange phase=${String(rawPhase)} countdown=${String(rawCountdown)} tanks=${String(tankCount)}`);
      const snapshot = this.parseState(state);
      this.stateBuffer.push({ timestamp: Date.now(), state: snapshot });

      if (this.stateBuffer.length > 60) {
        this.stateBuffer = this.stateBuffer.slice(-30);
      }

      if (this.onPhaseChange) {
        this.onPhaseChange(snapshot.phase, snapshot.winnerId);
      }
    });

    this.inputHandler.attach(this.playerIndex, (keys: InputState, seq: number) => {
      this.room?.send('input', { keys, seq });
    });

    this.startRenderLoop();
  }

  private parseState(raw: Record<string, unknown>): SnapshotState {
    const tanks = new Map<string, ClientTankState>();
    iterateMap(raw['tanks'], (t, key) => {
      const rawEffects = t['effects'];
      const effects: ActiveEffectData[] = [];
      iterateArray(rawEffects, (e) => {
        effects.push({
          type: asStr(e['type']),
          remainingTime: asNum(e['remainingTime']),
          remainingAmmo: asNum(e['remainingAmmo']),
        });
      });
      tanks.set(key, {
        id: asStr(t['id']),
        x: asNum(t['x']),
        y: asNum(t['y']),
        angle: asNum(t['angle']),
        speed: 0,
        alive: asBool(t['alive'], true),
        effects,
      });
    });

    const bullets: BulletState[] = [];
    iterateArray(raw['bullets'], (b) => {
      bullets.push({
        id: asStr(b['id']),
        ownerId: asStr(b['ownerId']),
        x: asNum(b['x']),
        y: asNum(b['y']),
        vx: asNum(b['vx']),
        vy: asNum(b['vy']),
        age: 0,
      });
    });

    const missiles: MissileState[] = [];
    iterateArray(raw['missiles'], (m) => {
      missiles.push({
        id: asStr(m['id']),
        ownerId: asStr(m['ownerId']),
        x: asNum(m['x']),
        y: asNum(m['y']),
        vx: asNum(m['vx']),
        vy: asNum(m['vy']),
        age: asNum(m['age']),
        initialTargetId: '',
      });
    });

    const powerups: PowerupSnapshot[] = [];
    iterateArray(raw['powerups'], (p) => {
      powerups.push({
        id: asStr(p['id']),
        type: asStr(p['type']),
        x: asNum(p['x']),
        y: asNum(p['y']),
      });
    });

    const lives = new Map<string, number>();
    const rawLives = raw['lives'];
    if (rawLives && typeof rawLives === 'object' && 'forEach' in rawLives) {
      (rawLives as { forEach: (cb: (v: unknown, k: string) => void) => void }).forEach((v, k) => {
        lives.set(k, asNum(v));
      });
    }

    return {
      tanks,
      bullets,
      missiles,
      powerups,
      countdown: asNum(raw['countdown']),
      phase: asStr(raw['phase'], 'countdown'),
      winnerId: asStr(raw['winnerId']),
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

    if (!before) return this.stateBuffer[this.stateBuffer.length - 1].state;
    if (!after) return before.state;

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
          angle: bTank.angle + (aTank.angle - bTank.angle) * t,
          speed: aTank.speed,
          alive: aTank.alive,
          effects: aTank.effects,
        });
      } else {
        tanks.set(key, bTank);
      }
    });

    const bullets: BulletState[] = after.state.bullets.map((aBullet) => {
      const bBullet = before.state.bullets.find((b) => b.id === aBullet.id);
      if (bBullet) {
        return {
          id: aBullet.id,
          ownerId: aBullet.ownerId,
          x: bBullet.x + (aBullet.x - bBullet.x) * t,
          y: bBullet.y + (aBullet.y - bBullet.y) * t,
          vx: aBullet.vx,
          vy: aBullet.vy,
          age: aBullet.age,
        };
      }
      return aBullet;
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
      lives: after.state.lives,
    };
  }

  private draw(): void {
    const { width, height } = this.canvas;
    clearCanvas(this.ctx, width, height);

    if (this.mazeSegments.length > 0) {
      drawMaze(this.ctx, this.mazeSegments);
    }

    const state = this.getInterpolatedState();
    if (!state) return;

    const now = Date.now();

    // Draw powerups
    for (const powerup of state.powerups) {
      drawPowerup(this.ctx, powerup, now);
    }

    // Draw tanks (skip dead tanks, but assign color by order so colors stay consistent)
    const tankColors = ['#4ade80', '#f87171'];
    let colorIdx = 0;
    state.tanks.forEach((tank) => {
      const color = tankColors[colorIdx % 2];
      colorIdx++;
      if (!tank.alive) return;
      // Cast to TankState for drawTank (it only uses x, y, angle)
      const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: tank.speed };
      drawTank(this.ctx, ts, color);
      drawTankPowerupIndicator(this.ctx, tank, tank.effects, now);
    });

    // Draw bullets
    for (const bullet of state.bullets) {
      drawBullet(this.ctx, bullet);
    }

    // Draw missiles
    for (const missile of state.missiles) {
      drawMissile(this.ctx, missile);
    }

    // Draw HUD
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

    if (state.phase === 'countdown') {
      drawCountdown(this.ctx, width, height, state.countdown);
    }
  }

  setMazeSegments(segments: LineSegment[]): void {
    this.mazeSegments = segments;
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
