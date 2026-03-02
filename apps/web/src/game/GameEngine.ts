import type { Room } from '@colyseus/sdk';
import { getStateCallbacks } from '@colyseus/sdk';
import type { Client } from '@colyseus/sdk';
import type { InputState, TankState, BulletState, MissileState, Vec2 } from '@tankbet/game-engine/physics';
import {
  shortestAngleDelta,
  degreesToRadians,
  updateTank,
  clampTankToMaze,
  collideTankWithWalls,
  collideTankWithEndpoints,
  extractWallEndpoints,
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
  PHYSICS_STEP,
  MISSILE_RADIUS,
  MISSILE_LIFETIME_SECONDS,
  SNAP_THRESHOLD_PX,
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
import type { TankRoomState } from '@tankbet/game-engine/schema';
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

// Event interfaces for broadcast-based projectile handling
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

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

const MAZE_WIDTH = MAZE_COLS * CELL_SIZE;
const MAZE_HEIGHT = MAZE_ROWS * CELL_SIZE;
const MAX_PHYSICS_STEPS_PER_FRAME = 6;

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

  // Client-side prediction state
  private predictedTank: TankState | null = null;
  private wallEndpoints: Vec2[] = [];
  private lastPredictionTime = 0;
  private physicsAccumulator = 0;

  // 1-tick input delay: match server input timing to eliminate prediction error
  private delayedInput: InputState = { up: false, down: false, left: false, right: false, fire: false };

  // Visual offset correction: render-only, never touches simulation
  private displayOffsetX = 0;
  private displayOffsetY = 0;
  private displayOffsetAngle = 0;


  // Remote tank interpolation
  private remoteTanks = new Map<string, RemoteTankState>();

  // Projectile state (event-driven)
  private activeBullets = new Map<string, BulletState>();
  private activeMissiles = new Map<string, MissileState>();

  // Game state tracking (replaces parseState/stateBuffer)
  private currentPhase = 'waiting';
  private currentCountdown = 0;
  private currentWinnerId = '';
  private currentRoundWinnerId = '';
  private currentLives = new Map<string, number>();
  private currentPowerups: Array<{ id: string; type: string; x: number; y: number }> = [];
  private tankAliveState = new Map<string, boolean>();
  private tankEffects = new Map<string, ActiveEffectData[]>();

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
      this.wallEndpoints = extractWallEndpoints(data.segments);
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
    // NOTE: $.tanks.onChange is NOT recursive for Schema children in Colyseus 0.14+.
    // Property changes on individual Tank instances (x, y, alive, etc.) must be
    // listened to via per-instance callbacks registered inside onAdd.
    $.tanks.onAdd((tank, sessionId) => {
      // Track insertion order for color assignment
      if (!this.tankSessionOrder.includes(sessionId)) {
        this.tankSessionOrder.push(sessionId);
      }

      if (sessionId === this.localSessionId) {
        this.predictedTank = {
          id: tank.id,
          x: tank.x,
          y: tank.y,
          angle: tank.angle,
          speed: tank.speed,
        };
        this.lastPredictionTime = performance.now();
      } else {
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
          updateInterval: 50, // initial guess (1000/20)
        });
      }

      this.tankAliveState.set(sessionId, tank.alive);
      this.syncTankEffects(tank, sessionId);

      // Per-instance change listener — fires when ANY property on this tank changes
      const tankProxy = getCallbacks(tank);
      tankProxy.onChange(() => {
        // Detect alive -> dead transitions for explosions
        const wasAlive = this.tankAliveState.get(sessionId);
        if (wasAlive === true && !tank.alive) {
          this.explosions.push({ x: tank.x, y: tank.y, startTime: Date.now() });
        }
        this.tankAliveState.set(sessionId, tank.alive);
        this.syncTankEffects(tank, sessionId);

        if (sessionId === this.localSessionId) {
          // === Visual offset correction ===
          // Snap simulation to server authority. Absorb the visual
          // difference into a render-only offset that decays per-frame.
          // This keeps prediction clean (never corrupted by blending)
          // while making corrections imperceptible to the player.
          const serverState: TankState = {
            id: tank.id,
            x: tank.x,
            y: tank.y,
            angle: tank.angle,
            speed: tank.speed,
          };

          if (!tank.alive || this.currentPhase !== 'playing') {
            // Not playing — accept server state directly, no offset
            this.predictedTank = serverState;
            this.displayOffsetX = 0;
            this.displayOffsetY = 0;
            this.displayOffsetAngle = 0;
            return;
          }

          if (!this.predictedTank) {
            this.predictedTank = serverState;
          } else {
            // Error = where we think we are minus where server says
            const errorX = this.predictedTank.x - serverState.x;
            const errorY = this.predictedTank.y - serverState.y;
            const errorAngle = shortestAngleDelta(this.predictedTank.angle, serverState.angle);
            const errorDist = Math.sqrt(errorX * errorX + errorY * errorY);

            if (errorDist > SNAP_THRESHOLD_PX || Math.abs(errorAngle) > 30) {
              // Teleport — too far off, snap everything
              this.predictedTank = serverState;
              this.displayOffsetX = 0;
              this.displayOffsetY = 0;
              this.displayOffsetAngle = 0;
            } else {
              // Absorb error into display offset so rendered position
              // stays visually at the old spot, then snap sim to server
              this.displayOffsetX += errorX;
              this.displayOffsetY += errorY;
              this.displayOffsetAngle += errorAngle;
              this.predictedTank = serverState;
            }
          }
        } else {
          // === Remote tank interpolation update ===
          const remote = this.remoteTanks.get(sessionId);
          if (remote) {
            const now = performance.now();
            const elapsed = now - remote.lastUpdateTime;
            // Adaptive update interval (EMA)
            if (elapsed > 0 && elapsed < 200) {
              remote.updateInterval = remote.updateInterval * 0.7 + elapsed * 0.3;
            }
            // Shift previous target to prev (not render position, which
            // depends on frame timing and creates variable interpolation)
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
      this.tankEffects.delete(sessionId);
    });

    // -----------------------------------------------------------------------
    // Bullet event handlers
    // -----------------------------------------------------------------------
    room.onMessage('bullet:fire', (data: BulletFireEvent) => {
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

    room.onMessage('bullet:bounce', (data: BulletBounceEvent) => {
      const bullet = this.activeBullets.get(data.id);
      if (bullet) {
        bullet.vx = data.vx;
        bullet.vy = data.vy;
      }
    });

    room.onMessage('bullet:remove', (data: BulletRemoveEvent) => {
      this.activeBullets.delete(data.id);
    });

    room.onMessage('bullet:clear', () => {
      this.activeBullets.clear();
    });

    room.onMessage('bullet:sync', (bullets: BulletState[]) => {
      this.activeBullets.clear();
      for (const b of bullets) {
        this.activeBullets.set(b.id, { ...b });
      }
    });

    // -----------------------------------------------------------------------
    // Missile event handlers
    // -----------------------------------------------------------------------
    room.onMessage('missile:fire', (data: MissileFireEvent) => {
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

    room.onMessage('missile:bounce', (data: MissileBounceEvent) => {
      const missile = this.activeMissiles.get(data.id);
      if (missile) {
        missile.x = data.x;
        missile.y = data.y;
        missile.vx = data.vx;
        missile.vy = data.vy;
      }
    });

    room.onMessage('missile:remove', (data: MissileRemoveEvent) => {
      this.activeMissiles.delete(data.id);
    });

    room.onMessage('missile:clear', () => {
      this.activeMissiles.clear();
    });

    room.onMessage('missile:sync', (missiles: MissileState[]) => {
      this.activeMissiles.clear();
      for (const m of missiles) {
        this.activeMissiles.set(m.id, { ...m });
      }
    });

    // -----------------------------------------------------------------------
    // Powerup callbacks
    // -----------------------------------------------------------------------
    $.powerups.onAdd((powerup) => {
      this.currentPowerups.push({ id: powerup.id, type: powerup.type, x: powerup.x, y: powerup.y });
    });

    $.powerups.onRemove((powerup) => {
      this.currentPowerups = this.currentPowerups.filter((p) => p.id !== powerup.id);
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

  /** Run the same 4-step physics pipeline the server uses for a single tick. */
  private stepTankPhysics(prev: TankState, input: InputState, dt: number): TankState {
    const moved = updateTank(prev, { ...input, fire: false }, dt);
    const clamped = clampTankToMaze(moved, MAZE_WIDTH, MAZE_HEIGHT);
    const { tank: wallCorrected } = collideTankWithWalls(clamped, prev, this.mazeSegments);
    return collideTankWithEndpoints(wallCorrected, this.wallEndpoints);
  }

  private syncTankEffects(tank: { effects: Iterable<{ type: string; remainingTime: number; remainingAmmo: number }> }, sessionId: string): void {
    const effects: ActiveEffectData[] = [];
    for (const e of tank.effects) {
      effects.push({ type: e.type, remainingTime: e.remainingTime, remainingAmmo: e.remainingAmmo });
    }
    this.tankEffects.set(sessionId, effects);
  }

  private notifyPhaseChange(): void {
    if (this.onPhaseChange) {
      this.onPhaseChange(this.currentPhase, this.currentWinnerId, this.currentRoundWinnerId);
    }
  }

  // -------------------------------------------------------------------------
  // Prediction (local-only, no input replay)
  // -------------------------------------------------------------------------

  private runPrediction(dt: number): void {
    if (!this.predictedTank || this.mazeSegments.length === 0) return;
    // Don't predict tank during non-playing phases (countdown, waiting, etc.)
    // to avoid accumulating drift that causes flicker on phase transition
    const skipTankPrediction = this.currentPhase !== 'playing';

    const currentInput = this.inputHandler.getKeys();

    // Advance tank physics using the PREVIOUS tick's input.
    // This 1-tick delay (~16.67ms, imperceptible) matches the server's
    // behavior where input arrives between ticks and applies on the next one,
    // eliminating the systematic 2.13px prediction error on input changes.
    if (!skipTankPrediction) {
      this.predictedTank = this.stepTankPhysics(this.predictedTank, this.delayedInput, dt);
    }
    this.delayedInput = currentInput;

    // Advance bullets with wall bounce
    const bulletToRemove: string[] = [];
    for (const [id, bullet] of this.activeBullets) {
      const advanced = advanceBullet(bullet, dt, this.mazeSegments);
      if (!advanced) {
        bulletToRemove.push(id);
        continue;
      }
      this.activeBullets.set(id, advanced);
    }
    for (const id of bulletToRemove) {
      this.activeBullets.delete(id);
    }

    // Advance missiles with homing + wall bounce
    const missileTankSnapshots: TankState[] = [];
    if (this.predictedTank) {
      missileTankSnapshots.push(this.predictedTank);
    }
    this.remoteTanks.forEach((remote, sessionId) => {
      const alive = this.tankAliveState.get(sessionId);
      if (alive) {
        missileTankSnapshots.push({
          id: sessionId,
          x: remote.x,
          y: remote.y,
          angle: remote.angle,
          speed: remote.speed,
        });
      }
    });

    const missileToRemove: string[] = [];
    for (const [id, missile] of this.activeMissiles) {
      const prevX = missile.x;
      const prevY = missile.y;
      const updated = updateMissile(missile, missileTankSnapshots, this.mazeSegments, dt);

      if (updated.age >= MISSILE_LIFETIME_SECONDS) {
        missileToRemove.push(id);
        continue;
      }

      // Wall bounce detection for missiles
      let resultX = updated.x;
      let resultY = updated.y;
      let resultVx = updated.vx;
      let resultVy = updated.vy;
      for (const wall of this.mazeSegments) {
        const { crossed, hitX, hitY } = bulletCrossesWall(prevX, prevY, resultX, resultY, wall);
        if (crossed) {
          const reflected = reflectBulletAtWall(
            { id, ownerId: missile.ownerId, x: resultX, y: resultY, vx: resultVx, vy: resultVy, age: 0 },
            wall,
            hitX,
            hitY,
            MISSILE_RADIUS,
          );
          resultX = reflected.x;
          resultY = reflected.y;
          resultVx = reflected.vx;
          resultVy = reflected.vy;
          break;
        }
      }

      missile.x = resultX;
      missile.y = resultY;
      missile.vx = resultVx;
      missile.vy = resultVy;
      missile.age = updated.age;
      missile.initialTargetId = updated.initialTargetId;
    }
    for (const id of missileToRemove) {
      this.activeMissiles.delete(id);
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

      // Dead-reckon beyond target if moving
      if (t > 1.0 && remote.speed !== 0) {
        const extraTime = (elapsed - remote.updateInterval) / 1000;
        const rad = degreesToRadians(remote.angle);
        remote.x += Math.cos(rad) * remote.speed * extraTime;
        remote.y += Math.sin(rad) * remote.speed * extraTime;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Per-frame display offset decay (render-only, never touches simulation)
  // -------------------------------------------------------------------------

  private decayDisplayOffset(frameDt: number): void {
    // Rate ~4 → corrections converge in ~300ms. Slower convergence
    // prioritizes visual smoothness over positional accuracy.
    const CORRECTION_RATE = 4;
    const keep = Math.exp(-CORRECTION_RATE * frameDt);

    this.displayOffsetX *= keep;
    this.displayOffsetY *= keep;
    // Snap angle immediately — angle offsets cause the most visible wobble
    // since they change movement direction, so don't smooth them
    this.displayOffsetAngle = 0;

    // Snap to zero when negligible (0.5px threshold to cut off slide sooner)
    if (Math.abs(this.displayOffsetX) < 0.5) this.displayOffsetX = 0;
    if (Math.abs(this.displayOffsetY) < 0.5) this.displayOffsetY = 0;
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

    // Fixed timestep accumulator for local prediction
    const perfNow = performance.now();
    if (this.lastPredictionTime === 0) {
      this.lastPredictionTime = perfNow;
    }
    let frameDt = (perfNow - this.lastPredictionTime) / 1000;
    this.lastPredictionTime = perfNow;
    frameDt = Math.min(frameDt, MAX_PHYSICS_STEPS_PER_FRAME * PHYSICS_STEP);
    this.physicsAccumulator += frameDt;

    while (this.physicsAccumulator >= PHYSICS_STEP) {
      this.runPrediction(PHYSICS_STEP);
      this.physicsAccumulator -= PHYSICS_STEP;
    }

    // Decay visual offset every frame (render-only correction)
    this.decayDisplayOffset(frameDt);

    // Interpolate remote tanks
    this.interpolateRemoteTanks();

    // Draw powerups
    for (const powerup of this.currentPowerups) {
      drawPowerup(this.ctx, powerup, now);
    }

    // Draw tanks
    const tankColors = ['#4ade80', '#f87171'];

    // Draw local tank at simulation position + visual offset
    if (this.predictedTank) {
      const localAlive = this.tankAliveState.get(this.localSessionId);
      if (localAlive) {
        const localOrderIdx = this.tankSessionOrder.indexOf(this.localSessionId);
        const localColor = tankColors[localOrderIdx >= 0 ? localOrderIdx % 2 : 0];
        const renderState: TankState = {
          ...this.predictedTank,
          x: this.predictedTank.x + this.displayOffsetX,
          y: this.predictedTank.y + this.displayOffsetY,
          angle: this.predictedTank.angle + this.displayOffsetAngle,
        };
        drawTank(this.ctx, renderState, localColor);
      }
    }

    // Draw remote tanks
    this.remoteTanks.forEach((remote, sessionId) => {
      const alive = this.tankAliveState.get(sessionId);
      if (!alive) return;
      const orderIdx = this.tankSessionOrder.indexOf(sessionId);
      const color = tankColors[orderIdx >= 0 ? orderIdx % 2 : 1];
      const ts: TankState = { id: sessionId, x: remote.x, y: remote.y, angle: remote.angle, speed: remote.speed };
      drawTank(this.ctx, ts, color);
    });

    // Draw bullets
    for (const bullet of this.activeBullets.values()) {
      drawBullet(this.ctx, bullet);
    }

    // Draw missiles
    for (const missile of this.activeMissiles.values()) {
      drawMissile(this.ctx, missile);
    }

    // Draw and prune expired explosions
    this.explosions = this.explosions.filter((exp) => now - exp.startTime < EXPLOSION_DURATION_MS);
    for (const exp of this.explosions) {
      drawExplosion(this.ctx, exp.x, exp.y, now - exp.startTime);
    }

    // HUD effects: gather by session order
    const p1SessionId = this.tankSessionOrder[0] ?? '';
    const p2SessionId = this.tankSessionOrder[1] ?? '';
    const p1Effects = this.tankEffects.get(p1SessionId) ?? [];
    const p2Effects = this.tankEffects.get(p2SessionId) ?? [];

    if (this.isPractice) {
      drawHUD(this.ctx, width, height, '', '', 0, 0, 0, p1Effects, p2Effects);
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
        p1Effects,
        p2Effects,
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
