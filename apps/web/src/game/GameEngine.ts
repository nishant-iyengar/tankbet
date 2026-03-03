import type { Room } from '@colyseus/sdk';
import { getStateCallbacks } from '@colyseus/sdk';
import type { Client } from '@colyseus/sdk';
import type { InputState, TankState, BulletState } from '@tankbet/game-engine/physics';
import {
  shortestAngleDelta,
  advanceBullet,
  degreesToRadians,
} from '@tankbet/game-engine/physics';
import type { LineSegment } from '@tankbet/game-engine/maze';
import { PHYSICS_STEP, BULLET_CORRECTION_BLEND_RATE, BARREL_LENGTH, TANK_WIDTH } from '@tankbet/game-engine/constants';
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
import type { TankRoomState } from '@tankbet/game-engine/schema';
import { InputHandler } from './InputHandler';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

// Timestamped snapshot for interpolation buffer
interface TankSnapshot {
  time: number; // performance.now() when received
  x: number;
  y: number;
  angle: number;
  speed: number;
}

// Default interpolation buffer delay — render this far in the past.
// At 60Hz patches (~17ms intervals), 100ms ≈ 6 ticks of buffer. Absorbs
// typical internet jitter while adding imperceptible latency for a tank game.
const DEFAULT_INTERP_DELAY_MS = 100;
const MAX_SNAPSHOTS = 8;

interface TankInterpolationState {
  snapshots: TankSnapshot[];
  // Current rendered position (output of interpolation)
  x: number;
  y: number;
  angle: number;
  speed: number;
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

interface BulletCorrectionEntry {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
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

  // Tank interpolation buffer (all tanks — local + remote use the same path)
  private tankStates = new Map<string, TankInterpolationState>();

  // Event-driven bullets — client simulates physics between server events
  private activeBullets = new Map<string, BulletState>();

  // Visual offsets for smooth server corrections.
  // When a correction arrives, we compute error = serverPos - clientPos, set it as
  // the offset, then decay the offset to zero over time. The bullet renders at
  // physicsPos + offset, so physics is never disturbed.
  private bulletOffsets = new Map<string, { dx: number; dy: number }>();

  // Fixed-timestep accumulator for bullet physics
  private lastFrameTime = 0;
  private physicsAccumulator = 0;

  // Latency tracking for bullet fast-forward on spawn
  private estimatedOneWayLatencySeconds = 0.025; // initial guess: 25ms
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  // Game state tracking
  private currentPhase = 'waiting';
  private currentCountdown = 0;
  private currentWinnerId = '';
  private currentRoundWinnerId = '';
  private currentLives = new Map<string, number>();
  private tankAliveState = new Map<string, boolean>();

  // Track session ID insertion order for color assignment
  private tankSessionOrder: string[] = [];

  // userId → sessionId mapping (for looking up visual tank position by ownerId)
  private userIdToSessionId = new Map<string, string>();

  // Interpolation buffer delay (ms) — configurable per instance
  private interpDelayMs = DEFAULT_INTERP_DELAY_MS;

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
    // Latency measurement — smoothed EMA of one-way latency for bullet fast-forward
    // -----------------------------------------------------------------------
    this.pingInterval = setInterval(() => {
      room.ping((rttMs: number) => {
        const oneWaySeconds = (rttMs / 2) / 1000;
        // Exponential moving average (smooth out jitter)
        this.estimatedOneWayLatencySeconds =
          this.estimatedOneWayLatencySeconds * 0.7 + oneWaySeconds * 0.3;
      });
    }, 2000);
    // Take an initial measurement immediately
    room.ping((rttMs: number) => {
      this.estimatedOneWayLatencySeconds = (rttMs / 2) / 1000;
    });

    // -----------------------------------------------------------------------
    // Maze message
    // -----------------------------------------------------------------------
    room.onMessage('maze', (data: { segments: LineSegment[] }) => {
      console.log(`[GameEngine] received maze: ${data.segments.length} segments`);
      this.setMazeSegments(data.segments);
    });

    // -----------------------------------------------------------------------
    // Bullet event handlers (event-driven, not schema)
    // -----------------------------------------------------------------------
    room.onMessage('bullet:fire', (data: BulletFireEvent) => {
      // Spawn the bullet at the visual tank's barrel tip, not the server
      // position. The tank is rendered interpDelayMs in the past, so the
      // server position is ahead of what the player sees. Spawning at the
      // visual barrel tip looks correct.
      let spawnX = data.x;
      let spawnY = data.y;

      const ownerTank = this.findTankByUserId(data.ownerId);
      if (ownerTank) {
        const rad = degreesToRadians(ownerTank.angle);
        const spawnDist = BARREL_LENGTH + TANK_WIDTH / 2;
        spawnX = ownerTank.x + Math.cos(rad) * spawnDist;
        spawnY = ownerTank.y + Math.sin(rad) * spawnDist;
      }

      const bullet: BulletState = {
        id: data.id,
        ownerId: data.ownerId,
        x: spawnX,
        y: spawnY,
        vx: data.vx,
        vy: data.vy,
        age: 0,
      };

      this.activeBullets.set(data.id, bullet);
    });

    room.onMessage('bullet:bounce', (data: BulletBounceEvent) => {
      const bullet = this.activeBullets.get(data.id);
      if (bullet) {
        // The client already runs advanceBullet() which detects and applies
        // bounces locally. By the time this server event arrives (one RTT later),
        // the client has already bounced and moved past the bounce point.
        // Snapping position would jump the bullet BACKWARD.
        //
        // Only correct velocity direction if it mismatches (client missed a
        // bounce or bounced off the wrong wall).
        if (Math.sign(bullet.vx) !== Math.sign(data.vx) ||
            Math.sign(bullet.vy) !== Math.sign(data.vy)) {
          bullet.vx = data.vx;
          bullet.vy = data.vy;
        }
      }
    });

    room.onMessage('bullet:remove', (data: BulletRemoveEvent) => {
      this.activeBullets.delete(data.id);
      this.bulletOffsets.delete(data.id);
    });

    room.onMessage('bullet:clear', () => {
      this.activeBullets.clear();
      this.bulletOffsets.clear();
    });

    room.onMessage('bullet:sync', (bullets: BulletState[]) => {
      this.activeBullets.clear();
      this.bulletOffsets.clear();
      for (const b of bullets) {
        this.activeBullets.set(b.id, { ...b });
      }
    });

    room.onMessage('bullet:corrections', (corrections: BulletCorrectionEntry[]) => {
      for (const c of corrections) {
        const bullet = this.activeBullets.get(c.id);
        if (!bullet) continue;

        // Fast-forward the server position by estimated latency so it
        // represents where the server bullet is NOW, not where it was
        // when the message was sent.
        let sx = c.x;
        let sy = c.y;
        let svx = c.vx;
        let svy = c.vy;
        let remaining = this.estimatedOneWayLatencySeconds;
        while (remaining >= PHYSICS_STEP) {
          const advanced = advanceBullet(
            { id: c.id, ownerId: '', x: sx, y: sy, vx: svx, vy: svy, age: 0 },
            PHYSICS_STEP,
            this.mazeSegments,
          );
          if (!advanced) break;
          sx = advanced.x;
          sy = advanced.y;
          svx = advanced.vx;
          svy = advanced.vy;
          remaining -= PHYSICS_STEP;
        }

        const errorX = sx - bullet.x;
        const errorY = sy - bullet.y;

        // Only apply correction if error is significant (> 2px)
        if (errorX * errorX + errorY * errorY > 4) {
          // Save where the client currently is (visually)
          const existingOffset = this.bulletOffsets.get(c.id);
          const oldVisualX = bullet.x + (existingOffset?.dx ?? 0);
          const oldVisualY = bullet.y + (existingOffset?.dy ?? 0);

          // Snap PHYSICS to the server position (future simulation is now accurate)
          bullet.x = sx;
          bullet.y = sy;

          // Set visual offset so rendered position stays at oldVisual (no visible jump)
          // offset decays to zero → visual smoothly migrates to corrected physics
          this.bulletOffsets.set(c.id, {
            dx: oldVisualX - sx,
            dy: oldVisualY - sy,
          });
        }

        // Snap velocity if server disagrees (missed/wrong bounce)
        if (Math.sign(bullet.vx) !== Math.sign(svx) ||
            Math.sign(bullet.vy) !== Math.sign(svy)) {
          bullet.vx = svx;
          bullet.vy = svy;
        }
      }
    });

    // -----------------------------------------------------------------------
    // Schema callback proxy
    // -----------------------------------------------------------------------
    const getCallbacks = getStateCallbacks(room);
    if (!getCallbacks) throw new Error('Failed to get state callbacks');
    const $ = getCallbacks(room.state);

    // -----------------------------------------------------------------------
    // Tank schema callbacks — same interpolation path for local + remote
    // -----------------------------------------------------------------------
    $.tanks.onAdd((tank, sessionId) => {
      // Track insertion order for color assignment
      if (!this.tankSessionOrder.includes(sessionId)) {
        this.tankSessionOrder.push(sessionId);
      }

      // Map userId (tank.id) → sessionId for bullet spawn lookups
      if (tank.id) {
        this.userIdToSessionId.set(tank.id, sessionId);
      }

      const now = performance.now();
      const snapshot: TankSnapshot = { time: now, x: tank.x, y: tank.y, angle: tank.angle, speed: tank.speed };
      this.tankStates.set(sessionId, {
        snapshots: [snapshot],
        x: tank.x,
        y: tank.y,
        angle: tank.angle,
        speed: tank.speed,
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

        const isRespawn = wasAlive === false && tank.alive;
        this.tankAliveState.set(sessionId, tank.alive);

        const state = this.tankStates.get(sessionId);
        if (!state) return;

        const snapshotNow = performance.now();
        const snap: TankSnapshot = { time: snapshotNow, x: tank.x, y: tank.y, angle: tank.angle, speed: tank.speed };

        if (isRespawn) {
          // Clear buffer and snap to respawn position
          state.snapshots = [snap];
          state.x = tank.x;
          state.y = tank.y;
          state.angle = tank.angle;
          state.speed = tank.speed;
        } else {
          // If there's a large gap since the last snapshot (tank was idle, no
          // patches sent), insert a "bridge" snapshot just before the new one
          // with the old position. This prevents a lerp ratio of ~1.0 that
          // would cause an instant visual jump on the first movement frame.
          const lastSnap = state.snapshots[state.snapshots.length - 1];
          if (lastSnap && snapshotNow - lastSnap.time > 200) {
            // Bridge: old position, placed one patch interval (~17ms at 60Hz) before the new snapshot
            state.snapshots = [
              { time: snapshotNow - 17, x: lastSnap.x, y: lastSnap.y, angle: lastSnap.angle, speed: lastSnap.speed },
              snap,
            ];
          } else {
            state.snapshots.push(snap);
            if (state.snapshots.length > MAX_SNAPSHOTS) {
              state.snapshots.shift();
            }
          }
        }
      });
    });

    $.tanks.onRemove((_tank, sessionId) => {
      this.tankStates.delete(sessionId);
      this.tankAliveState.delete(sessionId);
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

  // Look up a tank's current visual state by userId (used for bullet spawn)
  private findTankByUserId(userId: string): TankInterpolationState | undefined {
    const sessionId = this.userIdToSessionId.get(userId);
    if (!sessionId) return undefined;
    return this.tankStates.get(sessionId);
  }

  // -------------------------------------------------------------------------
  // Advance bullets client-side (fixed timestep)
  // -------------------------------------------------------------------------

  private advanceProjectiles(frameDt: number): void {
    this.physicsAccumulator += frameDt;

    while (this.physicsAccumulator >= PHYSICS_STEP) {
      this.physicsAccumulator -= PHYSICS_STEP;

      const toRemove: string[] = [];
      this.activeBullets.forEach((bullet, id) => {
        const advanced = advanceBullet(bullet, PHYSICS_STEP, this.mazeSegments);
        if (!advanced) {
          toRemove.push(id);
          return;
        }
        // Update in-place
        bullet.x = advanced.x;
        bullet.y = advanced.y;
        bullet.vx = advanced.vx;
        bullet.vy = advanced.vy;
        bullet.age = advanced.age;
      });

      for (const id of toRemove) {
        this.activeBullets.delete(id);
        this.bulletOffsets.delete(id);
      }
    }

    // Decay visual offsets toward zero (runs once per frame, not per physics step)
    const decay = 1 - BULLET_CORRECTION_BLEND_RATE;
    this.bulletOffsets.forEach((offset, id) => {
      offset.dx *= decay;
      offset.dy *= decay;
      // Clear once sub-pixel
      if (offset.dx * offset.dx + offset.dy * offset.dy < 0.25) {
        this.bulletOffsets.delete(id);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Interpolate all tanks from snapshot buffer (render 20ms in the past)
  // -------------------------------------------------------------------------

  // Diagnostic: track interpolation quality
  private interpDiagCounter = 0;
  private interpDiagHits = 0;
  private interpDiagMisses = 0;

  private interpolateTanks(): void {
    const renderTime = performance.now() - this.interpDelayMs;

    this.tankStates.forEach((state) => {
      const snaps = state.snapshots;

      // Find the two snapshots bracketing renderTime
      // snaps are ordered by time (oldest first)
      let i = snaps.length - 1;
      while (i > 0 && snaps[i].time > renderTime) {
        i--;
      }

      if (i === snaps.length - 1) {
        // renderTime is past all snapshots — hold at latest position (no extrapolation)
        const latest = snaps[i];
        state.x = latest.x;
        state.y = latest.y;
        state.angle = latest.angle;
        state.speed = latest.speed;
        this.interpDiagMisses++;
      } else {
        // Lerp between snaps[i] and snaps[i+1]
        const a = snaps[i];
        const b = snaps[i + 1];
        const span = b.time - a.time;
        const t = span > 0 ? (renderTime - a.time) / span : 1;

        state.x = a.x + (b.x - a.x) * t;
        state.y = a.y + (b.y - a.y) * t;
        state.angle = a.angle + shortestAngleDelta(b.angle, a.angle) * t;
        state.speed = b.speed;
        this.interpDiagHits++;
      }

      // Prune old snapshots we'll never need again (keep at least 2)
      while (snaps.length > 2 && snaps[1].time < renderTime) {
        snaps.shift();
      }
    });

    // Log interpolation quality every ~2 seconds (~120 frames)
    this.interpDiagCounter++;
    if (this.interpDiagCounter >= 120) {
      const total = this.interpDiagHits + this.interpDiagMisses;
      if (total > 0) {
        const hitRate = ((this.interpDiagHits / total) * 100).toFixed(1);
        console.log(`[Interp] hit=${this.interpDiagHits} miss=${this.interpDiagMisses} rate=${hitRate}% snaps=${this.tankStates.values().next().value?.snapshots.length ?? 0}`);
      }
      this.interpDiagCounter = 0;
      this.interpDiagHits = 0;
      this.interpDiagMisses = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  private startRenderLoop(): void {
    this.lastFrameTime = performance.now();
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

    // Advance bullet physics with fixed timestep
    const frameDt = Math.min((perfNow - this.lastFrameTime) / 1000, 0.05); // cap at 50ms
    this.lastFrameTime = perfNow;
    this.advanceProjectiles(frameDt);

    // Interpolate all tanks
    this.interpolateTanks();

    // Draw all tanks uniformly
    const tankColors = ['#4ade80', '#f87171'];

    this.tankStates.forEach((state, sessionId) => {
      const alive = this.tankAliveState.get(sessionId);
      if (!alive) return;
      const orderIdx = this.tankSessionOrder.indexOf(sessionId);
      const color = tankColors[orderIdx >= 0 ? orderIdx % 2 : 0];
      const ts: TankState = { id: sessionId, x: state.x, y: state.y, angle: state.angle, speed: state.speed };
      drawTank(this.ctx, ts, color);
    });

    // Draw bullets from client-side simulation, applying visual correction offsets
    this.activeBullets.forEach((bullet) => {
      const offset = this.bulletOffsets.get(bullet.id);
      if (offset) {
        drawBullet(this.ctx, { ...bullet, x: bullet.x + offset.dx, y: bullet.y + offset.dy });
      } else {
        drawBullet(this.ctx, bullet);
      }
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

  setInterpDelay(ms: number): void {
    this.interpDelayMs = ms;
  }

  forfeit(): void {
    this.room?.send('forfeit');
    this.destroy();
  }

  destroy(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.inputHandler.detach();
    void this.room?.leave();
    this.room = null;
    this.client = null;
  }
}
