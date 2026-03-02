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
  updateMissile,
  bulletCrossesWall,
  reflectBulletAtWall,
} from '@tankbet/game-engine/physics';
import type { LineSegment } from '@tankbet/game-engine/maze';
import type { ActiveEffectData } from '@tankbet/game-engine/powerups';
import {
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
  INTERPOLATION_DELAY_MS,
  PowerupType,
  MISSILE_LIFETIME_SECONDS,
  MISSILE_RADIUS,
} from '@tankbet/game-engine/constants';
import {
  clearCanvas,
  drawMaze,
  drawTank,
  drawBullet,
  drawMissile,
  drawPowerup,
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

interface BulletFireEvent {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface BulletBounceEvent {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface BulletRemoveEvent {
  id: string;
}

interface MissileFireEvent {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  initialTargetId: string;
}

interface MissileBounceEvent {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface MissileRemoveEvent {
  id: string;
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
const RECONCILE_LERP_PER_FRAME = 0.25; // blend factor per render frame toward server target
const RECONCILE_DONE_THRESHOLD = 0.5; // px — stop blending when error is below this
const MAZE_WIDTH = MAZE_COLS * CELL_SIZE;
const MAZE_HEIGHT = MAZE_ROWS * CELL_SIZE;
// Unconfirmed predicted bullets are discarded after this age (server rejected or lost)
const UNCONFIRMED_BULLET_MAX_AGE_S = 0.5;
// Fixed timestep for deterministic physics independent of frame rate
const PHYSICS_STEP = 1 / 60;
const MAX_PHYSICS_STEPS_PER_FRAME = 6; // cap to prevent spiral of death

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
  private physicsAccumulator = 0;

  // Smooth tank reconciliation: store server target and blend per-frame
  private serverTankTarget: { x: number; y: number; angle: number } | null = null;

  // Event-based bullet sync
  private activeBullets = new Map<string, BulletState>();
  // Event-based missile sync
  private activeMissiles = new Map<string, MissileState>();
  // Predicted bullets awaiting server confirmation (local player only)
  private pendingLocalBullets = new Map<string, BulletState>();
  private nextLocalBulletSeq = 0;
  private lastFireTime = 0;

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
    });

    // Bullet event handlers
    this.room.onMessage('bullet:fire', (data: BulletFireEvent) => {
      const localTankId = this.predictedTank?.id;
      if (localTankId && data.ownerId === localTankId) {
        // Match to closest pending predicted bullet
        let bestId: string | null = null;
        let bestDistSq = Infinity;
        for (const [predId, pred] of this.pendingLocalBullets) {
          const dx = pred.x - data.x;
          const dy = pred.y - data.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestId = predId;
          }
        }
        if (bestId !== null) {
          // Promote predicted bullet: keep its advanced position but swap to
          // the server-authoritative ID so future bounce/remove events match.
          const predicted = this.activeBullets.get(bestId);
          this.pendingLocalBullets.delete(bestId);
          this.activeBullets.delete(bestId);
          if (predicted) {
            this.activeBullets.set(data.id, {
              ...predicted,
              id: data.id,
              vx: data.vx,
              vy: data.vy,
            });
            return; // already tracking this bullet — skip adding at spawn pos
          }
        }
      }
      // Add the server bullet to active set (remote player or no matching prediction)
      this.activeBullets.set(data.id, {
        id: data.id,
        ownerId: data.ownerId,
        x: data.x,
        y: data.y,
        vx: data.vx,
        vy: data.vy,
        age: 0,
      });
    });

    this.room.onMessage('bullet:bounce', (data: BulletBounceEvent) => {
      const bullet = this.activeBullets.get(data.id);
      if (bullet) {
        bullet.x = data.x;
        bullet.y = data.y;
        bullet.vx = data.vx;
        bullet.vy = data.vy;
      }
    });

    this.room.onMessage('bullet:remove', (data: BulletRemoveEvent) => {
      this.activeBullets.delete(data.id);
    });

    this.room.onMessage('bullet:clear', () => {
      this.activeBullets.clear();
      this.pendingLocalBullets.clear();
    });

    this.room.onMessage('bullet:sync', (bullets: BulletState[]) => {
      this.activeBullets.clear();
      this.pendingLocalBullets.clear();
      for (const b of bullets) {
        this.activeBullets.set(b.id, { ...b });
      }
    });

    // Missile event handlers
    this.room.onMessage('missile:fire', (data: MissileFireEvent) => {
      this.activeMissiles.set(data.id, {
        id: data.id,
        ownerId: data.ownerId,
        x: data.x,
        y: data.y,
        vx: data.vx,
        vy: data.vy,
        age: 0,
        initialTargetId: data.initialTargetId,
      });
    });

    this.room.onMessage('missile:bounce', (data: MissileBounceEvent) => {
      const missile = this.activeMissiles.get(data.id);
      if (missile) {
        missile.x = data.x;
        missile.y = data.y;
        missile.vx = data.vx;
        missile.vy = data.vy;
      }
    });

    this.room.onMessage('missile:remove', (data: MissileRemoveEvent) => {
      this.activeMissiles.delete(data.id);
    });

    this.room.onMessage('missile:clear', () => {
      this.activeMissiles.clear();
    });

    this.room.onMessage('missile:sync', (missiles: MissileState[]) => {
      this.activeMissiles.clear();
      for (const m of missiles) {
        this.activeMissiles.set(m.id, { ...m });
      }
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
          this.serverTankTarget = null;
        } else {
          // Check error distance
          const dx = serverLocalTank.x - this.predictedTank.x;
          const dy = serverLocalTank.y - this.predictedTank.y;
          const errorDist = Math.sqrt(dx * dx + dy * dy);

          if (errorDist > SNAP_THRESHOLD) {
            // Large desync — teleport immediately
            this.predictedTank = {
              ...this.predictedTank,
              x: serverLocalTank.x,
              y: serverLocalTank.y,
              angle: serverLocalTank.angle,
            };
            this.serverTankTarget = null;
          } else {
            // Store server target for smooth per-frame blending
            this.serverTankTarget = {
              x: serverLocalTank.x,
              y: serverLocalTank.y,
              angle: serverLocalTank.angle,
            };
          }
        }
      }

      const now = Date.now();
      this.stateBuffer.push({ timestamp: now, state: snapshot });

      // Trim snapshots older than 3x interpolation delay (rolling window, no sharp cutoff)
      const cutoff = now - INTERPOLATION_DELAY_MS * 3;
      let trimCount = 0;
      while (trimCount < this.stateBuffer.length - 2 && this.stateBuffer[trimCount].timestamp < cutoff) {
        trimCount++;
      }
      if (trimCount > 0) {
        this.stateBuffer.splice(0, trimCount);
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

    // No bracketing snapshots — return latest state.
    if (!before || !after) {
      return this.stateBuffer[this.stateBuffer.length - 1].state;
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

    return {
      tanks,
      powerups: after.state.powerups,
      countdown: after.state.countdown,
      phase: after.state.phase,
      winnerId: after.state.winnerId,
      roundWinnerId: after.state.roundWinnerId,
      lives: after.state.lives,
    };
  }

  private runPrediction(dt: number, localEffects: ActiveEffectData[]): void {
    if (!this.predictedTank || this.mazeSegments.length === 0) return;

    const input = this.inputHandler.getKeys();
    const prevTank = this.predictedTank;

    // Skip bullet prediction when tank has a missile powerup — server fires a missile instead
    const hasMissileAmmo = localEffects.some(
      (e) => e.type === PowerupType.TARGETING_MISSILE && e.remainingAmmo > 0,
    );

    if (input.fire && hasMissileAmmo) {
      console.log('[prediction] skipping bullet — has missile ammo', localEffects);
    }
    if (input.fire && !hasMissileAmmo && localEffects.length > 0) {
      console.log('[prediction] firing bullet despite effects', localEffects);
    }

    // Fire every tick while fire is held AND cooldown ready (matches server behavior)
    const now = performance.now();
    // Count confirmed bullets from activeBullets + unconfirmed pending bullets
    const localTankId = this.predictedTank.id;
    let confirmedCount = 0;
    for (const b of this.activeBullets.values()) {
      if (b.ownerId === localTankId) confirmedCount++;
    }
    const totalBulletCount = confirmedCount + this.pendingLocalBullets.size;
    if (input.fire && !hasMissileAmmo && canFireBullet(now, this.lastFireTime, totalBulletCount)) {
      this.lastFireTime = now;
      const localId = `predicted_${this.nextLocalBulletSeq++}`;
      const bullet = createBullet(localId, this.predictedTank);
      this.activeBullets.set(localId, bullet);
      this.pendingLocalBullets.set(localId, bullet);
    }

    // Run the same 4-step physics pipeline the server uses
    const moved = updateTank(prevTank, { ...input, fire: false }, dt);
    const clamped = clampTankToMaze(moved, MAZE_WIDTH, MAZE_HEIGHT);
    const { tank: wallCorrected } = collideTankWithWalls(clamped, prevTank, this.mazeSegments);
    const final = collideTankWithEndpoints(wallCorrected, this.wallEndpoints);
    this.predictedTank = final;

    // Smooth reconciliation: blend toward server target per frame
    if (this.serverTankTarget && this.predictedTank) {
      const dx = this.serverTankTarget.x - this.predictedTank.x;
      const dy = this.serverTankTarget.y - this.predictedTank.y;
      const errorDist = Math.sqrt(dx * dx + dy * dy);

      if (errorDist < RECONCILE_DONE_THRESHOLD) {
        this.serverTankTarget = null;
      } else {
        this.predictedTank = {
          ...this.predictedTank,
          x: this.predictedTank.x + dx * RECONCILE_LERP_PER_FRAME,
          y: this.predictedTank.y + dy * RECONCILE_LERP_PER_FRAME,
          angle: this.predictedTank.angle + shortestAngleDelta(this.serverTankTarget.angle, this.predictedTank.angle) * RECONCILE_LERP_PER_FRAME,
        };
      }
    }

    // Advance ALL bullets locally at 60fps — handles wall bounces correctly
    const toRemove: string[] = [];
    for (const [id, bullet] of this.activeBullets) {
      const advanced = advanceBullet(bullet, dt, this.mazeSegments);
      if (!advanced) {
        toRemove.push(id);
        continue;
      }
      // For unconfirmed predicted bullets, discard if server hasn't confirmed in time
      if (this.pendingLocalBullets.has(id) && advanced.age >= UNCONFIRMED_BULLET_MAX_AGE_S) {
        toRemove.push(id);
        continue;
      }
      this.activeBullets.set(id, advanced);
    }
    for (const id of toRemove) {
      this.activeBullets.delete(id);
      this.pendingLocalBullets.delete(id);
    }

    // Advance missiles locally at 60fps
    // Build tank snapshots once for homing targets
    const missileTankSnapshots: TankState[] = [];
    const interpState = this.getInterpolatedState();
    if (interpState) {
      interpState.tanks.forEach((t) => {
        if (t.alive) {
          missileTankSnapshots.push({ id: t.id, x: t.x, y: t.y, angle: t.angle, speed: 0 });
        }
      });
    }
    // Override local tank with prediction
    if (this.predictedTank) {
      const idx = missileTankSnapshots.findIndex((t) => t.id === this.predictedTank?.id);
      if (idx >= 0) {
        missileTankSnapshots[idx] = this.predictedTank;
      }
    }

    const missileToRemove: string[] = [];
    for (const [id, missile] of this.activeMissiles) {
      const prevX = missile.x;
      const prevY = missile.y;
      const updated = updateMissile(missile, missileTankSnapshots, this.mazeSegments, dt);

      if (updated.age >= MISSILE_LIFETIME_SECONDS) {
        missileToRemove.push(id);
        continue;
      }

      // Handle wall bounces
      let result: BulletState = {
        id: updated.id,
        ownerId: updated.ownerId,
        x: updated.x,
        y: updated.y,
        vx: updated.vx,
        vy: updated.vy,
        age: updated.age,
      };
      for (const wall of this.mazeSegments) {
        const { crossed, hitX, hitY } = bulletCrossesWall(prevX, prevY, result.x, result.y, wall);
        if (crossed) {
          result = reflectBulletAtWall(result, wall, hitX, hitY, MISSILE_RADIUS);
          break;
        }
      }

      missile.x = result.x;
      missile.y = result.y;
      missile.vx = result.vx;
      missile.vy = result.vy;
      missile.age = updated.age;
      missile.initialTargetId = updated.initialTargetId;
    }
    for (const id of missileToRemove) {
      this.activeMissiles.delete(id);
    }
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

    // Run client-side prediction with fixed timestep for deterministic physics
    const perfNow = performance.now();
    if (this.lastPredictionTime === 0) {
      this.lastPredictionTime = perfNow;
    }
    let frameDt = (perfNow - this.lastPredictionTime) / 1000;
    this.lastPredictionTime = perfNow;
    frameDt = Math.min(frameDt, MAX_PHYSICS_STEPS_PER_FRAME * PHYSICS_STEP);
    this.physicsAccumulator += frameDt;

    const localTank = state.tanks.get(this.localSessionId);
    const localEffects = localTank?.effects ?? [];
    while (this.physicsAccumulator >= PHYSICS_STEP) {
      this.runPrediction(PHYSICS_STEP, localEffects);
      this.physicsAccumulator -= PHYSICS_STEP;
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
    });

    // Draw all active bullets (both server-confirmed and locally predicted)
    for (const bullet of this.activeBullets.values()) {
      drawBullet(this.ctx, bullet);
    }

    for (const missile of this.activeMissiles.values()) {
      drawMissile(this.ctx, missile);
    }

    // Draw and prune expired explosions
    this.explosions = this.explosions.filter((exp) => now - exp.startTime < EXPLOSION_DURATION_MS);
    for (const exp of this.explosions) {
      drawExplosion(this.ctx, exp.x, exp.y, now - exp.startTime);
    }

    // Collect effects for HUD missile indicators
    const tankEntries = Array.from(state.tanks.values());
    const p1Effects = tankEntries[0]?.effects ?? [];
    const p2Effects = tankEntries[1]?.effects ?? [];

    if (this.isPractice) {
      // Practice mode: show missile indicators without names/lives/bet
      drawHUD(this.ctx, width, height, '', '', 0, 0, 0, p1Effects, p2Effects);
    } else {
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
        p1Effects,
        p2Effects,
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
