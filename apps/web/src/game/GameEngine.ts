import type { Client, Room } from '@colyseus/sdk';
import type { InputState, TankState, BulletState, MissileState, Vec2 } from '@tankbet/game-engine/physics';
import {
  shortestAngleDelta,
  updateTank,
  clampTankToMaze,
  collideTankWithWalls,
  collideTankWithEndpoints,
  extractWallEndpoints,
  canFireBullet,
  createBullet,
  advanceBullet,
} from '@tankbet/game-engine/physics';
import type { LineSegment } from '@tankbet/game-engine/maze';
import type { ActiveEffectData } from '@tankbet/game-engine/powerups';
import {
  INTERPOLATION_DELAY_MS,
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
} from '@tankbet/game-engine/constants';
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

const SNAP_THRESHOLD = 50; // px — teleport to server if prediction drifts further
const RECONCILE_LERP = 0.2; // blend factor toward server position per state update
const MAZE_WIDTH = MAZE_COLS * CELL_SIZE;
const MAZE_HEIGHT = MAZE_ROWS * CELL_SIZE;
// Unconfirmed predicted bullets are discarded after this age (server rejected or lost)
const UNCONFIRMED_BULLET_MAX_AGE_S = 0.5;

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

  // Client-side prediction state
  private predictedTank: TankState | null = null;
  private wallEndpoints: Vec2[] = [];
  private lastPredictionTime = 0;

  // Client-side bullet prediction
  private predictedBullets: BulletState[] = [];
  private nextLocalBulletSeq = 0;
  private lastFireTime = 0;
  private knownServerBulletIds = new Set<string>();
  // Queue of predicted bullets awaiting server confirmation, oldest first
  private pendingBulletQueue: BulletState[] = [];
  // Predicted bullet ID → server bullet ID (established on server confirmation)
  private predictedToServerId = new Map<string, string>();
  // Server bullet IDs to suppress in interpolated state after their predicted
  // bullet has been removed (avoids ghost re-appearance during interpolation delay)
  private suppressedServerBulletIds = new Map<string, number>(); // serverId → timestamp

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
      this.wallEndpoints = extractWallEndpoints(data.segments);
      // Reset bullet prediction state on new maze (new round)
      this.predictedBullets = [];
      this.pendingBulletQueue = [];
      this.knownServerBulletIds.clear();
      this.predictedToServerId.clear();
      this.suppressedServerBulletIds.clear();
    });

    this.room.onStateChange((state: TankRoomState) => {
      const snapshot = this.parseState(state);

      // Detect alive → dead transitions and spawn explosions
      snapshot.tanks.forEach((tank, sessionId) => {
        const wasAlive = this.prevTankAlive.get(sessionId);
        if (wasAlive === true && !tank.alive) {
          this.explosions.push({ x: tank.x, y: tank.y, startTime: Date.now() });
        }
        this.prevTankAlive.set(sessionId, tank.alive);
      });

      // Server reconciliation for predicted tank
      const serverLocalTank = snapshot.tanks.get(this.localSessionId);
      if (serverLocalTank) {
        if (!this.predictedTank) {
          // Initialize prediction from first server snapshot
          this.predictedTank = {
            id: serverLocalTank.id,
            x: serverLocalTank.x,
            y: serverLocalTank.y,
            angle: serverLocalTank.angle,
            speed: serverLocalTank.speed,
          };
          this.lastPredictionTime = performance.now();
        } else if (!serverLocalTank.alive) {
          // Tank died — snap prediction to server so respawn position is correct
          this.predictedTank = {
            id: serverLocalTank.id,
            x: serverLocalTank.x,
            y: serverLocalTank.y,
            angle: serverLocalTank.angle,
            speed: serverLocalTank.speed,
          };
        } else {
          // Reconcile: blend or snap toward server position
          const dx = serverLocalTank.x - this.predictedTank.x;
          const dy = serverLocalTank.y - this.predictedTank.y;
          const errorDist = Math.sqrt(dx * dx + dy * dy);

          if (errorDist > SNAP_THRESHOLD) {
            // Large desync — teleport
            this.predictedTank = {
              ...this.predictedTank,
              x: serverLocalTank.x,
              y: serverLocalTank.y,
              angle: serverLocalTank.angle,
            };
          } else {
            // Gentle lerp toward server
            this.predictedTank = {
              ...this.predictedTank,
              x: this.predictedTank.x + dx * RECONCILE_LERP,
              y: this.predictedTank.y + dy * RECONCILE_LERP,
              angle: this.predictedTank.angle + shortestAngleDelta(serverLocalTank.angle, this.predictedTank.angle) * RECONCILE_LERP,
            };
          }
        }
      }

      // Reconcile predicted bullets with server bullets (same approach as tank).
      const localTankId = this.predictedTank?.id;
      const currentServerBulletIds = new Set<string>();

      // Collect new server bullets for our tank this update
      const newLocalServerBullets: BulletState[] = [];
      for (const b of snapshot.bullets) {
        currentServerBulletIds.add(b.id);
        if (!this.knownServerBulletIds.has(b.id) && localTankId && b.ownerId === localTankId) {
          newLocalServerBullets.push(b);
        }
      }

      // Match new server bullets to predicted bullets by proximity (not queue
      // order) — handles timing mismatches when client/server fire rates diverge.
      const unmatchedPredicted = new Set(this.pendingBulletQueue.map((b) => b.id));
      for (const serverBullet of newLocalServerBullets) {
        let bestId: string | null = null;
        let bestDistSq = Infinity;
        for (const predicted of this.predictedBullets) {
          if (!unmatchedPredicted.has(predicted.id)) continue;
          const dx = predicted.x - serverBullet.x;
          const dy = predicted.y - serverBullet.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestId = predicted.id;
          }
        }
        if (bestId !== null) {
          this.predictedToServerId.set(bestId, serverBullet.id);
          unmatchedPredicted.delete(bestId);
          this.pendingBulletQueue = this.pendingBulletQueue.filter((b) => b.id !== bestId);
        }
      }
      this.knownServerBulletIds = currentServerBulletIds;

      // Nudge each matched predicted bullet toward its server counterpart
      // (same lerp-toward-server approach as tank reconciliation)
      const serverBulletMap = new Map<string, BulletState>();
      for (const b of snapshot.bullets) {
        serverBulletMap.set(b.id, b);
      }
      for (const predicted of this.predictedBullets) {
        const serverId = this.predictedToServerId.get(predicted.id);
        if (!serverId) continue;
        const server = serverBulletMap.get(serverId);
        if (server) {
          // Blend position toward server (like tank RECONCILE_LERP)
          predicted.x += (server.x - predicted.x) * RECONCILE_LERP;
          predicted.y += (server.y - predicted.y) * RECONCILE_LERP;
          // Snap velocity to server (handles wall bounces correctly)
          predicted.vx = server.vx;
          predicted.vy = server.vy;
          // Reset age so advanceBullet never expires this locally —
          // server is source of truth for bullet removal.
          predicted.age = 0;
        } else {
          // Server removed this bullet — suppress the server ID in the
          // interpolated view for INTERPOLATION_DELAY_MS so it doesn't
          // ghost-reappear from older snapshots.
          this.suppressedServerBulletIds.set(serverId, Date.now());
          this.predictedToServerId.delete(predicted.id);
          predicted.age = Infinity; // mark for removal in runPrediction
        }
      }

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

  // Count server-confirmed bullets owned by the local tank from the latest snapshot
  private countLocalServerBullets(): number {
    if (!this.predictedTank || this.stateBuffer.length === 0) return 0;
    const latest = this.stateBuffer[this.stateBuffer.length - 1].state;
    const tankId = this.predictedTank.id;
    return latest.bullets.filter((b) => b.ownerId === tankId).length;
  }

  private runPrediction(dt: number): void {
    if (!this.predictedTank || this.mazeSegments.length === 0) return;

    const input = this.inputHandler.getKeys();
    const prevTank = this.predictedTank;

    // Fire every tick while fire is held AND cooldown ready (matches server behavior)
    const now = performance.now();
    // Server count already includes confirmed predicted bullets, so only add
    // unconfirmed ones (pendingBulletQueue) to avoid double-counting.
    const serverBulletCount = this.countLocalServerBullets();
    const totalBulletCount = serverBulletCount + this.pendingBulletQueue.length;
    if (input.fire && canFireBullet(now, this.lastFireTime, totalBulletCount)) {
      this.lastFireTime = now;
      const localId = `predicted_${this.nextLocalBulletSeq++}`;
      const bullet = createBullet(localId, this.predictedTank);
      this.predictedBullets.push(bullet);
      this.pendingBulletQueue.push(bullet);
    }

    // Run the same 4-step physics pipeline the server uses
    const moved = updateTank(prevTank, { ...input, fire: false }, dt);
    const clamped = clampTankToMaze(moved, MAZE_WIDTH, MAZE_HEIGHT);
    const { tank: wallCorrected } = collideTankWithWalls(clamped, prevTank, this.mazeSegments);
    const final = collideTankWithEndpoints(wallCorrected, this.wallEndpoints);
    this.predictedTank = final;

    // Simulate predicted bullets using shared advanceBullet (same break-after-first-bounce as server)
    const survivingBullets = this.predictedBullets
      .map((bullet) => advanceBullet(bullet, dt, this.mazeSegments))
      .filter((b): b is BulletState => {
        if (!b) return false;
        // Matched bullets live as long as their server counterpart (removed in onStateChange)
        if (this.predictedToServerId.has(b.id)) return true;
        // Unmatched: discard if server hasn't confirmed in time
        return b.age < UNCONFIRMED_BULLET_MAX_AGE_S;
      });

    // Clean up pendingBulletQueue entries whose predicted bullet was removed
    const survivingIds = new Set(survivingBullets.map((b) => b.id));
    this.pendingBulletQueue = this.pendingBulletQueue.filter((b) => survivingIds.has(b.id));
    // Clean up stale mappings
    for (const predictedId of this.predictedToServerId.keys()) {
      if (!survivingIds.has(predictedId)) {
        this.predictedToServerId.delete(predictedId);
      }
    }

    this.predictedBullets = survivingBullets;
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

    // Run client-side prediction for local tank and bullets
    const perfNow = performance.now();
    if (this.lastPredictionTime === 0) {
      this.lastPredictionTime = perfNow;
    }
    const dt = (perfNow - this.lastPredictionTime) / 1000;
    this.lastPredictionTime = perfNow;
    if (dt > 0 && dt <= 0.1) {
      this.runPrediction(dt);
    }

    for (const powerup of state.powerups) {
      drawPowerup(this.ctx, powerup, now);
    }

    const tankColors = ['#4ade80', '#f87171'];
    let colorIdx = 0;
    state.tanks.forEach((tank, sessionId) => {
      const color = tankColors[colorIdx % 2];
      colorIdx++;
      if (!tank.alive) return;

      // Use predicted position for the local tank, interpolated for remote tanks
      if (sessionId === this.localSessionId && this.predictedTank) {
        drawTank(this.ctx, this.predictedTank, color);
      } else {
        const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: tank.speed };
        drawTank(this.ctx, ts, color);
      }
      drawTankPowerupIndicator(this.ctx, tank, tank.effects);
    });

    // Draw server bullets, skipping those that have a matched predicted bullet
    // or are suppressed (recently removed but still in interpolated state)
    const matchedServerIds = new Set(this.predictedToServerId.values());

    // Expire old suppression entries
    const suppressionCutoff = Date.now() - INTERPOLATION_DELAY_MS * 2;
    for (const [id, ts] of this.suppressedServerBulletIds) {
      if (ts < suppressionCutoff) this.suppressedServerBulletIds.delete(id);
    }

    for (const bullet of state.bullets) {
      if (matchedServerIds.has(bullet.id)) continue;
      if (this.suppressedServerBulletIds.has(bullet.id)) continue;
      drawBullet(this.ctx, bullet);
    }

    // Draw predicted bullets (already blended toward server in onStateChange)
    for (const bullet of this.predictedBullets) {
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
