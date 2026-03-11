import type { Room } from '@colyseus/sdk';
import { getStateCallbacks } from '@colyseus/sdk';
import type { Client } from '@colyseus/sdk';
import type { InputState, TankState, BulletState, Vec2, WallSegment } from '@tankbet/game-engine/physics';
import {
  shortestAngleDelta,
  advanceBullet,
  degreesToRadians,
  updateTank,
  clampTankToMaze,
  collideTankWithWalls,
  collideTankWithEndpoints,
  extractWallEndpoints,
  hermiteLerp,
  checkBulletTankCollision,
} from '@tankbet/game-engine/physics';
import type { LineSegment } from '@tankbet/game-engine/maze';
import {
  PHYSICS_STEP,
  CORRECTION_DECAY,
  REMOTE_INTERP_DELAY_MS,
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
  TANK_COLOR_P1,
  TANK_COLOR_P2,
} from '@tankbet/game-engine/constants';
import {
  clearCanvas,
  drawMaze,
  drawTank,
  drawBullet,
  drawTracks,
  drawCountdown,
  drawHUD,
  drawExplosion,
  EXPLOSION_DURATION_MS,
} from '@tankbet/game-engine/renderer';
import type { TrackMark } from '@tankbet/game-engine/renderer';
import { TRACK_LIFETIME_MS, TRACK_SPACING } from '@tankbet/game-engine/constants';

const BACKGROUND_COLOR = '#1a1a2e';
import type { TankRoomState } from '@tankbet/game-engine/schema';
import { InputHandler } from './InputHandler';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

// Timestamped snapshot for remote tank interpolation buffer
interface TankSnapshot {
  time: number; // performance.now() when received
  x: number;
  y: number;
  angle: number;
  speed: number;
}

const MAX_SNAPSHOTS = 16;

// Saved prediction entry for reconciliation
interface PredictionEntry {
  tick: number;
  input: InputState;
  x: number;
  y: number;
  angle: number;
}

// Error offset for visual smoothing (decays toward 0)
interface ErrorOffset {
  dx: number;
  dy: number;
  dAngle: number;
}

// Client-side bullet with error offset and prev position for alpha interp
interface ClientBullet {
  state: BulletState;
  error: { dx: number; dy: number };
  prevX: number;
  prevY: number;
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

// Remote tank interpolation state
interface RemoteTankState {
  snapshots: TankSnapshot[];
  x: number;
  y: number;
  angle: number;
  speed: number;
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
  private mazeCanvas: OffscreenCanvas | null = null;
  private animFrameId: number | null = null;
  private playerIndex: 0 | 1 = 0;
  private player1Name = '';
  private player2Name = '';
  private onPhaseChange: ((phase: string, winnerId: string, roundWinnerId: string) => void) | null = null;
  private localSessionId = '';
  private isPractice = false;
  private explosions: Array<{ x: number; y: number; startTime: number }> = [];

  // --- Local tank (client-side prediction) ---
  private localPhysics: TankState = { id: '', x: 0, y: 0, angle: 0, speed: 0 };
  private localPrevPhysics: { x: number; y: number; angle: number } = { x: 0, y: 0, angle: 0 };
  private localTankError: ErrorOffset = { dx: 0, dy: 0, dAngle: 0 };
  private localPrevError: ErrorOffset = { dx: 0, dy: 0, dAngle: 0 };
  private predictionBuffer: PredictionEntry[] = [];
  private currentInput: InputState = { up: false, down: false, left: false, right: false, fire: false };
  private clientTick = 0;

  // Maze collision data for client-side prediction
  private wallSegmentsTyped: WallSegment[] = [];
  private wallEndpoints: Vec2[] = [];
  private mazeWidth = MAZE_COLS * CELL_SIZE;
  private mazeHeight = MAZE_ROWS * CELL_SIZE;

  // --- Remote tank (snapshot interpolation) ---
  private remoteTankState: RemoteTankState | null = null;
  private remoteSessionId = '';

  // --- Bullets (simplified with error decay) ---
  private activeBullets = new Map<string, ClientBullet>();

  // --- Fixed-timestep accumulator ---
  private lastFrameTime = 0;
  private accumulator = 0;

  // Set when a new maze arrives — forces next local tank update to snap instead of lerp
  private snapNextLocalUpdate = false;

  // Ping/RTT measurement for lag compensation
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;

  // Game state tracking
  private currentPhase = 'waiting';
  private currentCountdown = 0;
  private currentWinnerId = '';
  private currentRoundWinnerId = '';
  private currentLives = new Map<string, number>();
  private tankAliveState = new Map<string, boolean>();

  // Tank track marks (tread trails)
  private trackMarks: TrackMark[] = [];
  private lastTrackPos = new Map<string, { x: number; y: number }>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
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
    practice = false,
  ): Promise<void> {
    this.client = colyseusClient;
    this.playerIndex = playerIndex;
    this.player1Name = player1Name;
    this.player2Name = player2Name;
    this.isPractice = practice;

    const room = await this.client.consumeSeatReservation<TankRoomState>(seatReservation);
    this.setupRoom(room);
  }

  async reconnect(
    colyseusClient: Client,
    reconnectionToken: string,
    playerIndex: 0 | 1,
    player1Name: string,
    player2Name: string,
  ): Promise<void> {
    this.client = colyseusClient;
    this.playerIndex = playerIndex;
    this.player1Name = player1Name;
    this.player2Name = player2Name;
    this.isPractice = false;

    const room = await this.client.reconnect<TankRoomState>(reconnectionToken);
    this.setupRoom(room);
    // Request maze + bullet state now that message handlers are registered
    room.send('request:state');
  }

  getReconnectionToken(): string | null {
    return this.room?.reconnectionToken ?? null;
  }

  private setupRoom(room: Room<TankRoomState>): void {
    this.room = room;
    this.localSessionId = room.sessionId;

    // -----------------------------------------------------------------------
    // Maze message
    // -----------------------------------------------------------------------
    room.onMessage('maze', (data: { segments: LineSegment[] }) => {
      this.setMazeSegments(data.segments);
    });

    // -----------------------------------------------------------------------
    // Bullet event handlers (event-driven, not schema)
    // -----------------------------------------------------------------------
    room.onMessage('bullet:fire', (data: BulletFireEvent) => {
      const bullet: BulletState = {
        id: data.id,
        ownerId: data.ownerId,
        x: data.x,
        y: data.y,
        vx: data.vx,
        vy: data.vy,
        age: 0,
      };

      // For local bullets, nudge spawn toward the predicted tank position.
      // localTankError is the small offset between predicted and server positions
      // (~2-5px), keeping the bullet visually close to the barrel tip.
      const isLocal = data.ownerId === this.localPhysics.id;
      const errorDx = isLocal ? this.localTankError.dx : 0;
      const errorDy = isLocal ? this.localTankError.dy : 0;

      this.activeBullets.set(data.id, {
        state: bullet,
        error: { dx: errorDx, dy: errorDy },
        prevX: data.x + errorDx,
        prevY: data.y + errorDy,
      });
    });

    room.onMessage('bullet:bounce', (data: BulletBounceEvent) => {
      const cb = this.activeBullets.get(data.id);
      if (!cb) return;

      // Snap physics to server position, compute visual error offset
      const oldVisualX = cb.state.x + cb.error.dx;
      const oldVisualY = cb.state.y + cb.error.dy;
      cb.state.x = data.x;
      cb.state.y = data.y;
      cb.state.vx = data.vx;
      cb.state.vy = data.vy;
      cb.error.dx = oldVisualX - data.x;
      cb.error.dy = oldVisualY - data.y;
    });

    room.onMessage('bullet:remove', (data: BulletRemoveEvent) => {
      this.activeBullets.delete(data.id);
    });

    room.onMessage('bullet:clear', () => {
      this.activeBullets.clear();
    });

    room.onMessage('bullet:sync', (bullets: BulletState[]) => {
      const serverIds = new Set<string>();
      for (const b of bullets) {
        serverIds.add(b.id);
        const existing = this.activeBullets.get(b.id);
        if (existing) {
          // Smooth correction: compute visual error offset, snap physics to server
          const oldVisualX = existing.state.x + existing.error.dx;
          const oldVisualY = existing.state.y + existing.error.dy;
          existing.state = { ...b };
          existing.error.dx = oldVisualX - b.x;
          existing.error.dy = oldVisualY - b.y;
        } else {
          // New bullet we didn't know about
          this.activeBullets.set(b.id, {
            state: { ...b },
            error: { dx: 0, dy: 0 },
            prevX: b.x,
            prevY: b.y,
          });
        }
      }
      // Remove bullets the server no longer has
      for (const id of this.activeBullets.keys()) {
        if (!serverIds.has(id)) {
          this.activeBullets.delete(id);
        }
      }
    });

    // -----------------------------------------------------------------------
    // Ping/RTT measurement for lag compensation
    // -----------------------------------------------------------------------
    room.onMessage('pong', (data: { clientTime: number }) => {
      const rtt = performance.now() - data.clientTime;
      room.send('rtt', { rtt });
    });

    // Send first ping immediately so RTT is available before first shot
    room.send('ping', { clientTime: performance.now() });
    this.pingIntervalId = setInterval(() => {
      room.send('ping', { clientTime: performance.now() });
    }, 2000);

    // -----------------------------------------------------------------------
    // Schema callback proxy
    // -----------------------------------------------------------------------
    const getCallbacks = getStateCallbacks(room);
    if (!getCallbacks) throw new Error('Failed to get state callbacks');
    const $ = getCallbacks(room.state);

    // -----------------------------------------------------------------------
    // Tank schema callbacks — split local vs remote
    // -----------------------------------------------------------------------
    $.tanks.onAdd((tank, sessionId) => {
      this.tankAliveState.set(sessionId, tank.alive);

      if (sessionId === this.localSessionId) {
        // Initialize local prediction state
        this.localPhysics = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };
        this.localPrevPhysics = { x: tank.x, y: tank.y, angle: tank.angle };
        this.localTankError = { dx: 0, dy: 0, dAngle: 0 };
        this.localPrevError = { dx: 0, dy: 0, dAngle: 0 };
        this.predictionBuffer = [];

        const tankProxy = getCallbacks(tank);
        tankProxy.onChange(() => {
          // Detect alive state transitions
          const wasAlive = this.tankAliveState.get(sessionId);
          if (wasAlive === true && !tank.alive) {
            this.explosions.push({ x: tank.x, y: tank.y, startTime: Date.now() });
            // Reset input state so stale held-key inputs don't accumulate
            this.currentInput = { up: false, down: false, left: false, right: false, fire: false };
            this.inputHandler.resetKeys();
          }
          const isRespawn = wasAlive === false && tank.alive;
          this.tankAliveState.set(sessionId, tank.alive);

          if (isRespawn || this.snapNextLocalUpdate) {
            // Snap to new position — either respawn or new battle (maze changed)
            this.snapNextLocalUpdate = false;
            this.localPhysics = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };
            this.localPrevPhysics = { x: tank.x, y: tank.y, angle: tank.angle };
            this.localTankError = { dx: 0, dy: 0, dAngle: 0 };
            this.localPrevError = { dx: 0, dy: 0, dAngle: 0 };
            this.predictionBuffer = [];
            if (isRespawn) {
              // Re-send current input so server picks up any keys held during death
              this.room?.send('input', { keys: this.currentInput, tick: this.clientTick });
            }
            return;
          }

          // Server reconciliation
          this.reconcileLocalTank(tank.lastInputSeq, tank.x, tank.y, tank.angle);
        });
      } else {
        // Remote tank — snapshot interpolation
        this.remoteSessionId = sessionId;
        const now = performance.now();
        const snapshot: TankSnapshot = { time: now, x: tank.x, y: tank.y, angle: tank.angle, speed: tank.speed };
        this.remoteTankState = {
          snapshots: [snapshot],
          x: tank.x,
          y: tank.y,
          angle: tank.angle,
          speed: tank.speed,
        };

        const tankProxy = getCallbacks(tank);
        tankProxy.onChange(() => {
          // Detect alive state transitions
          const wasAlive = this.tankAliveState.get(sessionId);
          if (wasAlive === true && !tank.alive) {
            this.explosions.push({ x: tank.x, y: tank.y, startTime: Date.now() });
          }
          const isRespawn = wasAlive === false && tank.alive;
          this.tankAliveState.set(sessionId, tank.alive);

          if (!this.remoteTankState) return;
          const snapshotNow = performance.now();
          const snap: TankSnapshot = { time: snapshotNow, x: tank.x, y: tank.y, angle: tank.angle, speed: tank.speed };

          // Snap when respawning or when snapshots were cleared (new battle/maze)
          if (isRespawn || this.remoteTankState.snapshots.length === 0) {
            this.remoteTankState.snapshots = [snap];
            this.remoteTankState.x = tank.x;
            this.remoteTankState.y = tank.y;
            this.remoteTankState.angle = tank.angle;
            this.remoteTankState.speed = tank.speed;
          } else {
            this.remoteTankState.snapshots.push(snap);
            if (this.remoteTankState.snapshots.length > MAX_SNAPSHOTS) {
              this.remoteTankState.snapshots.shift();
            }
          }
        });
      }
    });

    $.tanks.onRemove((_tank, sessionId) => {
      this.tankAliveState.delete(sessionId);
      this.lastTrackPos.delete(sessionId);
      if (sessionId === this.remoteSessionId) {
        this.remoteTankState = null;
        this.remoteSessionId = '';
      }
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
    // Input handler — sends to server on key state changes, updates prediction
    // -----------------------------------------------------------------------
    this.inputHandler.attach(this.playerIndex, (keys: InputState) => {
      this.currentInput = keys;
      // Don't send inputs while dead — prevents stale pendingInputs on the
      // server that would move the tank before the client knows about respawn.
      const alive = this.tankAliveState.get(this.localSessionId);
      if (alive) {
        this.room?.send('input', { keys, tick: this.clientTick });
      }
    });

    this.startGameLoop();
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
  // Server reconciliation for local tank
  // -------------------------------------------------------------------------

  private reconcileLocalTank(lastInputSeq: number, serverX: number, serverY: number, serverAngle: number): void {
    // Discard acknowledged predictions
    this.predictionBuffer = this.predictionBuffer.filter((e) => e.tick > lastInputSeq);

    // Save pre-reconciliation physics state
    const oldX = this.localPhysics.x;
    const oldY = this.localPhysics.y;
    const oldAngle = this.localPhysics.angle;

    // Snap physics to server position
    this.localPhysics.x = serverX;
    this.localPhysics.y = serverY;
    this.localPhysics.angle = serverAngle;

    // Replay unacknowledged inputs
    for (const entry of this.predictionBuffer) {
      const prevState: TankState = { ...this.localPhysics };
      const moved = updateTank(prevState, { ...entry.input, fire: false }, PHYSICS_STEP);
      const clamped = clampTankToMaze(moved, this.mazeWidth, this.mazeHeight);
      const { tank: collided } = collideTankWithWalls(clamped, prevState, this.wallSegmentsTyped);
      const shielded = collideTankWithEndpoints(collided, this.wallEndpoints);
      this.localPhysics.x = Math.fround(shielded.x);
      this.localPhysics.y = Math.fround(shielded.y);
      this.localPhysics.angle = Math.fround(shielded.angle);
    }

    // Compare post-replay position with pre-reconciliation position
    const dx = this.localPhysics.x - oldX;
    const dy = this.localPhysics.y - oldY;
    const dAngle = shortestAngleDelta(this.localPhysics.angle, oldAngle);

    // Threshold tolerates input-timing mismatch (1-tick divergence ≈ 2.75px, 3.33°).
    // Keep tight so tank position stays close to server truth (affects bullet hits).
    if (dx * dx + dy * dy < 25 && dAngle * dAngle < 25) {
      // Prediction was correct — restore original position, don't touch interpolation state
      this.localPhysics.x = oldX;
      this.localPhysics.y = oldY;
      this.localPhysics.angle = oldAngle;
      return;
    }

    // Prediction was wrong — compute error offset for smooth visual correction
    const oldVisualX = oldX + this.localTankError.dx;
    const oldVisualY = oldY + this.localTankError.dy;
    const oldVisualAngle = oldAngle + this.localTankError.dAngle;

    this.localTankError.dx = oldVisualX - this.localPhysics.x;
    this.localTankError.dy = oldVisualY - this.localPhysics.y;
    this.localTankError.dAngle = shortestAngleDelta(oldVisualAngle, this.localPhysics.angle);
  }

  // -------------------------------------------------------------------------
  // Physics tick (runs at fixed 60Hz)
  // -------------------------------------------------------------------------

  private physicsTick(): void {
    this.clientTick++;

    // --- Local tank prediction ---
    const localAlive = this.tankAliveState.get(this.localSessionId);
    if (localAlive) {
      // Save prev for alpha interpolation
      this.localPrevPhysics.x = this.localPhysics.x;
      this.localPrevPhysics.y = this.localPhysics.y;
      this.localPrevPhysics.angle = this.localPhysics.angle;
      this.localPrevError = { ...this.localTankError };

      // Apply current input
      const prevState: TankState = { ...this.localPhysics };
      const moved = updateTank(prevState, { ...this.currentInput, fire: false }, PHYSICS_STEP);
      const clamped = clampTankToMaze(moved, this.mazeWidth, this.mazeHeight);
      const { tank: collided } = collideTankWithWalls(clamped, prevState, this.wallSegmentsTyped);
      const shielded = collideTankWithEndpoints(collided, this.wallEndpoints);
      // Quantize to float32 to match server precision (schema uses float32)
      this.localPhysics.x = Math.fround(shielded.x);
      this.localPhysics.y = Math.fround(shielded.y);
      this.localPhysics.angle = Math.fround(shielded.angle);
      this.localPhysics.speed = Math.fround(moved.speed);

      // Save prediction entry
      this.predictionBuffer.push({
        tick: this.clientTick,
        input: { ...this.currentInput },
        x: this.localPhysics.x,
        y: this.localPhysics.y,
        angle: this.localPhysics.angle,
      });
      // Keep buffer bounded
      if (this.predictionBuffer.length > 120) {
        this.predictionBuffer = this.predictionBuffer.slice(-60);
      }

      // Decay local tank error
      this.localTankError.dx *= CORRECTION_DECAY;
      this.localTankError.dy *= CORRECTION_DECAY;
      this.localTankError.dAngle *= CORRECTION_DECAY;
    }

    // --- Advance bullets ---
    const bulletsToRemove: string[] = [];
    this.activeBullets.forEach((cb, id) => {
      // Save prev visual position for alpha interp
      cb.prevX = cb.state.x + cb.error.dx;
      cb.prevY = cb.state.y + cb.error.dy;

      const advanced = advanceBullet(cb.state, PHYSICS_STEP, this.mazeSegments);
      if (!advanced) {
        bulletsToRemove.push(id);
        return;
      }
      cb.state.x = advanced.x;
      cb.state.y = advanced.y;
      cb.state.vx = advanced.vx;
      cb.state.vy = advanced.vy;
      cb.state.age = advanced.age;

      cb.error.dx *= 0.85;
      cb.error.dy *= 0.85;
    });

    for (const id of bulletsToRemove) {
      this.activeBullets.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Interpolate remote tank from snapshot buffer (200ms in the past)
  // -------------------------------------------------------------------------

  private interpolateRemoteTank(): void {
    if (!this.remoteTankState) return;
    const state = this.remoteTankState;
    const snaps = state.snapshots;
    if (snaps.length === 0) return;
    const renderTime = performance.now() - REMOTE_INTERP_DELAY_MS;

    // Find the two snapshots bracketing renderTime
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].time > renderTime) {
      i--;
    }

    if (i === snaps.length - 1) {
      // renderTime is past all snapshots — hold at latest
      const latest = snaps[i];
      state.x = latest.x;
      state.y = latest.y;
      state.angle = latest.angle;
      state.speed = latest.speed;
    } else {
      const a = snaps[i];
      const b = snaps[i + 1];
      const span = b.time - a.time;
      const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - a.time) / span)) : 1;

      // Cubic Hermite interpolation — uses 4 snapshots when available for smooth
      // acceleration/deceleration curves instead of velocity discontinuities.
      // Falls back to linear lerp when only 2 snapshots are available.
      const p0 = i > 0 ? snaps[i - 1] : null;
      const p3 = i + 2 < snaps.length ? snaps[i + 2] : null;

      const spanPrev = p0 ? a.time - p0.time : 0;
      const spanNext = p3 ? p3.time - b.time : 0;

      state.x = hermiteLerp(p0?.x ?? null, a.x, b.x, p3?.x ?? null, t, spanPrev, span, spanNext);
      state.y = hermiteLerp(p0?.y ?? null, a.y, b.y, p3?.y ?? null, t, spanPrev, span, spanNext);

      // Angle always uses shortest-path lerp (Hermite on angles can overshoot badly)
      state.angle = a.angle + shortestAngleDelta(b.angle, a.angle) * t;
      state.speed = b.speed;
    }

    // Prune old snapshots (keep at least 4 for Hermite interpolation)
    while (snaps.length > 4 && snaps[2].time < renderTime) {
      snaps.shift();
    }
  }

  // -------------------------------------------------------------------------
  // Fixed-timestep game loop with alpha interpolation
  // -------------------------------------------------------------------------

  private startGameLoop(): void {
    this.lastFrameTime = performance.now();
    this.accumulator = 0;
    const loop = (timestamp: number): void => {
      const frameTime = Math.min((timestamp - this.lastFrameTime) / 1000, 0.1); // cap to prevent spiral of death
      this.lastFrameTime = timestamp;
      this.accumulator += frameTime;

      while (this.accumulator >= PHYSICS_STEP) {
        this.physicsTick();
        this.accumulator -= PHYSICS_STEP;
      }

      const alpha = this.accumulator / PHYSICS_STEP;
      this.render(alpha);
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private render(alpha: number): void {
    const { width, height } = this.canvas;

    if (this.mazeCanvas) {
      this.ctx.drawImage(this.mazeCanvas, 0, 0);
    } else {
      clearCanvas(this.ctx, width, height);
      if (this.mazeSegments.length > 0) {
        drawMaze(this.ctx, this.mazeSegments);
      }
    }

    const now = Date.now();

    // Interpolate remote tank (snapshot-based, no alpha needed)
    this.interpolateRemoteTank();

    // --- Emit track marks ---
    // Local tank
    const localAlive = this.tankAliveState.get(this.localSessionId);
    if (localAlive && this.localPhysics.speed !== 0) {
      const localRenderX = this.localPrevPhysics.x + this.localPrevError.dx +
        (this.localPhysics.x + this.localTankError.dx - this.localPrevPhysics.x - this.localPrevError.dx) * alpha;
      const localRenderY = this.localPrevPhysics.y + this.localPrevError.dy +
        (this.localPhysics.y + this.localTankError.dy - this.localPrevPhysics.y - this.localPrevError.dy) * alpha;
      this.emitTrackMark(this.localSessionId, localRenderX, localRenderY, this.localPhysics.angle, now);
    }

    // Remote tank
    if (this.remoteTankState && this.tankAliveState.get(this.remoteSessionId) && this.remoteTankState.speed !== 0) {
      this.emitTrackMark(this.remoteSessionId, this.remoteTankState.x, this.remoteTankState.y, this.remoteTankState.angle, now);
    }

    // Prune expired track marks
    this.trackMarks = this.trackMarks.filter((t) => now - t.time < TRACK_LIFETIME_MS);
    drawTracks(this.ctx, this.trackMarks, now, TRACK_LIFETIME_MS);

    // --- Draw local tank (alpha interpolated) ---
    if (localAlive) {
      const prevVisX = this.localPrevPhysics.x + this.localPrevError.dx;
      const prevVisY = this.localPrevPhysics.y + this.localPrevError.dy;
      const prevVisAngle = this.localPrevPhysics.angle + this.localPrevError.dAngle;
      const curVisX = this.localPhysics.x + this.localTankError.dx;
      const curVisY = this.localPhysics.y + this.localTankError.dy;
      const curVisAngle = this.localPhysics.angle + this.localTankError.dAngle;

      const renderX = prevVisX + (curVisX - prevVisX) * alpha;
      const renderY = prevVisY + (curVisY - prevVisY) * alpha;
      const renderAngle = prevVisAngle + shortestAngleDelta(curVisAngle, prevVisAngle) * alpha;

      const localColor = [TANK_COLOR_P1, TANK_COLOR_P2][this.playerIndex];
      const ts: TankState = { id: this.localSessionId, x: renderX, y: renderY, angle: renderAngle, speed: this.localPhysics.speed };
      drawTank(this.ctx, ts, localColor);
    }

    // --- Draw remote tank (snapshot interpolation) ---
    if (this.remoteTankState && this.tankAliveState.get(this.remoteSessionId)) {
      const remoteColor = [TANK_COLOR_P1, TANK_COLOR_P2][1 - this.playerIndex];
      const ts: TankState = {
        id: this.remoteSessionId,
        x: this.remoteTankState.x,
        y: this.remoteTankState.y,
        angle: this.remoteTankState.angle,
        speed: this.remoteTankState.speed,
      };
      drawTank(this.ctx, ts, remoteColor);
    }

    // --- Draw bullets (alpha interpolated) ---
    this.activeBullets.forEach((cb) => {
      const curVisX = cb.state.x + cb.error.dx;
      const curVisY = cb.state.y + cb.error.dy;
      const bx = cb.prevX + (curVisX - cb.prevX) * alpha;
      const by = cb.prevY + (curVisY - cb.prevY) * alpha;
      drawBullet(this.ctx, { ...cb.state, x: bx, y: by });
    });

    // --- Explosions ---
    this.explosions = this.explosions.filter((exp) => now - exp.startTime < EXPLOSION_DURATION_MS);
    for (const exp of this.explosions) {
      drawExplosion(this.ctx, exp.x, exp.y, now - exp.startTime);
    }

    // --- HUD ---
    if (this.isPractice) {
      drawHUD(this.ctx, width, height, '', '', 0, 0);
    } else {
      const localLives = this.currentLives.get(this.localSessionId) ?? 0;
      const remoteLives = this.currentLives.get(this.remoteSessionId) ?? 0;
      const p1Lives = this.playerIndex === 0 ? localLives : remoteLives;
      const p2Lives = this.playerIndex === 0 ? remoteLives : localLives;
      drawHUD(this.ctx, width, height, this.player1Name, this.player2Name, p1Lives, p2Lives);
    }

    if (this.currentPhase === 'countdown') {
      drawCountdown(this.ctx, width, height, this.currentCountdown);
    }
  }

  // -------------------------------------------------------------------------
  // Track mark emission helper
  // -------------------------------------------------------------------------

  private emitTrackMark(sessionId: string, x: number, y: number, angle: number, now: number): void {
    const last = this.lastTrackPos.get(sessionId);
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy >= TRACK_SPACING * TRACK_SPACING) {
        const colorIdx = sessionId === this.localSessionId ? this.playerIndex : 1 - this.playerIndex;
        this.trackMarks.push({
          x,
          y,
          angle: degreesToRadians(angle),
          time: now,
          color: [TANK_COLOR_P1, TANK_COLOR_P2][colorIdx],
        });
        this.lastTrackPos.set(sessionId, { x, y });
      }
    } else {
      this.lastTrackPos.set(sessionId, { x, y });
    }
  }

  // -------------------------------------------------------------------------
  // Maze setup
  // -------------------------------------------------------------------------

  setMazeSegments(segments: LineSegment[]): void {
    this.mazeSegments = segments;
    // Convert LineSegment[] to WallSegment[] for physics functions
    this.wallSegmentsTyped = segments.map((seg) => ({
      x1: seg.x1,
      y1: seg.y1,
      x2: seg.x2,
      y2: seg.y2,
    }));
    this.wallEndpoints = extractWallEndpoints(this.wallSegmentsTyped);
    this.trackMarks = [];
    this.lastTrackPos.clear();

    // New maze means new battle — reset interpolation state so tanks snap
    // to their new spawn positions instead of lerping from the old maze.
    if (this.remoteTankState) {
      this.remoteTankState.snapshots = [];
    }
    this.localTankError = { dx: 0, dy: 0, dAngle: 0 };
    this.localPrevError = { dx: 0, dy: 0, dAngle: 0 };
    this.predictionBuffer = [];
    this.snapNextLocalUpdate = true;

    this.rebuildMazeCanvas();
  }

  private rebuildMazeCanvas(): void {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0 || this.mazeSegments.length === 0) {
      this.mazeCanvas = null;
      return;
    }
    const offscreen = new OffscreenCanvas(width, height);
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;
    offCtx.fillStyle = BACKGROUND_COLOR;
    offCtx.fillRect(0, 0, width, height);
    drawMaze(offCtx, this.mazeSegments);
    this.mazeCanvas = offscreen;
  }

  forfeit(): void {
    this.room?.send('forfeit');
    this.destroy();
  }

  destroy(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
    if (this.pingIntervalId !== null) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    this.inputHandler.detach();
    void this.room?.leave();
    this.room = null;
    this.client = null;
  }
}
