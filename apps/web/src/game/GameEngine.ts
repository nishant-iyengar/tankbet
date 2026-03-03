import type { Room } from '@colyseus/sdk';
import { getStateCallbacks } from '@colyseus/sdk';
import type { Client } from '@colyseus/sdk';
import type { InputState, TankState, BulletState, Vec2 } from '@tankbet/game-engine/physics';
import {
  shortestAngleDelta,
  advanceBullet,
  updateTank,
  clampTankToMaze,
  collideTankWithWalls,
  collideTankWithEndpoints,
  extractWallEndpoints,
} from '@tankbet/game-engine/physics';
import type { LineSegment } from '@tankbet/game-engine/maze';
import { PHYSICS_STEP, BULLET_CORRECTION_BLEND_RATE, MAZE_COLS, MAZE_ROWS, CELL_SIZE } from '@tankbet/game-engine/constants';
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

  // Tank interpolation (all tanks, including local)
  private remoteTanks = new Map<string, RemoteTankState>();

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

  // Client-side prediction for local tank
  private localPredictedTank: TankState | null = null;
  private localTankOffset: { dx: number; dy: number; dAngle: number } | null = null;
  private currentInputState: InputState = { up: false, down: false, left: false, right: false, fire: false };
  private tankPhysicsAccumulator = 0;
  private wallEndpoints: Vec2[] = [];
  private mazeWidth = 0;
  private mazeHeight = 0;

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
      this.wallEndpoints = extractWallEndpoints(data.segments);
      this.mazeWidth = MAZE_COLS * CELL_SIZE;
      this.mazeHeight = MAZE_ROWS * CELL_SIZE;
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

      // Fast-forward the bullet by estimated one-way latency so the client
      // starts at approximately where the server bullet currently is.
      // This eliminates the K-tick offset that causes bounce desync.
      let remaining = this.estimatedOneWayLatencySeconds;
      while (remaining >= PHYSICS_STEP) {
        const advanced = advanceBullet(bullet, PHYSICS_STEP, this.mazeSegments);
        if (!advanced) return; // bullet expired during fast-forward
        bullet.x = advanced.x;
        bullet.y = advanced.y;
        bullet.vx = advanced.vx;
        bullet.vy = advanced.vy;
        bullet.age = advanced.age;
        remaining -= PHYSICS_STEP;
      }

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
    // Tank schema callbacks
    // -----------------------------------------------------------------------
    $.tanks.onAdd((tank, sessionId) => {
      // Track insertion order for color assignment
      if (!this.tankSessionOrder.includes(sessionId)) {
        this.tankSessionOrder.push(sessionId);
      }

      const isLocal = sessionId === this.localSessionId;

      if (isLocal) {
        // Initialize client-side prediction state for local tank
        this.localPredictedTank = {
          id: sessionId,
          x: tank.x,
          y: tank.y,
          angle: tank.angle,
          speed: tank.speed,
        };
        this.localTankOffset = null;
        this.tankPhysicsAccumulator = 0;
      }

      // Remote tanks use interpolation; local tank entry is kept for color/alive tracking
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

        if (isLocal) {
          // --- Client-side prediction path for local tank ---
          const predicted = this.localPredictedTank;
          if (!predicted) return;

          if (isRespawn) {
            // Snap prediction to respawn position
            predicted.x = tank.x;
            predicted.y = tank.y;
            predicted.angle = tank.angle;
            predicted.speed = tank.speed;
            this.localTankOffset = null;
            this.tankPhysicsAccumulator = 0;
            return;
          }

          // Compare server position to our predicted position
          const errorX = tank.x - predicted.x;
          const errorY = tank.y - predicted.y;
          const errorSq = errorX * errorX + errorY * errorY;

          if (errorSq > 4) {
            // Error > 2px: snap prediction to server, preserve visual continuity via offset
            const existingOffset = this.localTankOffset;
            const oldVisualX = predicted.x + (existingOffset?.dx ?? 0);
            const oldVisualY = predicted.y + (existingOffset?.dy ?? 0);
            const oldVisualAngle = predicted.angle + (existingOffset?.dAngle ?? 0);

            predicted.x = tank.x;
            predicted.y = tank.y;

            this.localTankOffset = {
              dx: oldVisualX - tank.x,
              dy: oldVisualY - tank.y,
              dAngle: oldVisualAngle - tank.angle,
            };
          }

          // Always sync angle and speed from server to prevent drift
          predicted.angle = tank.angle;
          predicted.speed = tank.speed;
        } else {
          // --- Interpolation path for remote tanks ---
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
              // Use current visual position as interpolation start (fixes snap-back)
              remote.prevX = remote.x;
              remote.prevY = remote.y;
              remote.prevAngle = remote.angle;
              // Set new target
              remote.targetX = tank.x;
              remote.targetY = tank.y;
              remote.targetAngle = tank.angle;
              remote.targetSpeed = tank.speed;
              remote.lastUpdateTime = now;
            }
          }
        }
      });
    });

    $.tanks.onRemove((_tank, sessionId) => {
      this.remoteTanks.delete(sessionId);
      this.tankAliveState.delete(sessionId);
      if (sessionId === this.localSessionId) {
        this.localPredictedTank = null;
        this.localTankOffset = null;
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
    // Input handler — sends to server on key state changes only
    // -----------------------------------------------------------------------
    this.inputHandler.attach(this.playerIndex, (keys: InputState) => {
      this.currentInputState = { ...keys };
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
  // Advance local tank client-side (fixed timestep prediction)
  // -------------------------------------------------------------------------

  private advanceLocalTank(frameDt: number): void {
    const predicted = this.localPredictedTank;
    if (!predicted) return;

    // Don't predict while dead
    const alive = this.tankAliveState.get(this.localSessionId);
    if (!alive) return;

    this.tankPhysicsAccumulator += frameDt;

    while (this.tankPhysicsAccumulator >= PHYSICS_STEP) {
      this.tankPhysicsAccumulator -= PHYSICS_STEP;

      const prevTank = { ...predicted };
      const moved = updateTank(predicted, this.currentInputState, PHYSICS_STEP);
      predicted.x = moved.x;
      predicted.y = moved.y;
      predicted.angle = moved.angle;
      predicted.speed = moved.speed;

      // Clamp to maze bounds
      if (this.mazeWidth > 0) {
        const clamped = clampTankToMaze(predicted, this.mazeWidth, this.mazeHeight);
        predicted.x = clamped.x;
        predicted.y = clamped.y;
      }

      // Collide with walls
      if (this.mazeSegments.length > 0) {
        const result = collideTankWithWalls(predicted, prevTank, this.mazeSegments);
        predicted.x = result.tank.x;
        predicted.y = result.tank.y;
      }

      // Collide with wall endpoints (corner shield)
      if (this.wallEndpoints.length > 0) {
        const endpointResult = collideTankWithEndpoints(predicted, this.wallEndpoints);
        predicted.x = endpointResult.x;
        predicted.y = endpointResult.y;
      }
    }

    // Decay visual correction offset
    if (this.localTankOffset) {
      const decay = 1 - BULLET_CORRECTION_BLEND_RATE;
      this.localTankOffset.dx *= decay;
      this.localTankOffset.dy *= decay;
      this.localTankOffset.dAngle *= decay;
      // Clear once sub-pixel
      if (this.localTankOffset.dx * this.localTankOffset.dx +
          this.localTankOffset.dy * this.localTankOffset.dy < 0.25) {
        this.localTankOffset = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Interpolate remote tanks (skip local — it uses prediction)
  // -------------------------------------------------------------------------

  private interpolateRemoteTanks(): void {
    const now = performance.now();
    this.remoteTanks.forEach((remote, sessionId) => {
      // Skip local tank — rendered via client-side prediction
      if (sessionId === this.localSessionId) return;

      const elapsed = now - remote.lastUpdateTime;
      const t = Math.min(elapsed / remote.updateInterval, 1.5);

      // Lerp from prev to target, with mild extrapolation (t > 1) to cover patch gaps
      remote.x = remote.prevX + (remote.targetX - remote.prevX) * t;
      remote.y = remote.prevY + (remote.targetY - remote.prevY) * t;

      // Use shortestAngleDelta for angle interpolation
      const angleDelta = shortestAngleDelta(remote.targetAngle, remote.prevAngle);
      remote.angle = remote.prevAngle + angleDelta * t;

      remote.speed = remote.targetSpeed;
    });
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

    // Advance local tank prediction + interpolate remote tanks
    this.advanceLocalTank(frameDt);
    this.interpolateRemoteTanks();

    // Draw all tanks
    const tankColors = ['#4ade80', '#f87171'];

    this.remoteTanks.forEach((remote, sessionId) => {
      const alive = this.tankAliveState.get(sessionId);
      if (!alive) return;
      const orderIdx = this.tankSessionOrder.indexOf(sessionId);
      const color = tankColors[orderIdx >= 0 ? orderIdx % 2 : 0];

      if (sessionId === this.localSessionId && this.localPredictedTank) {
        // Local tank: render from prediction + visual offset
        const predicted = this.localPredictedTank;
        const offset = this.localTankOffset;
        const ts: TankState = {
          id: sessionId,
          x: predicted.x + (offset?.dx ?? 0),
          y: predicted.y + (offset?.dy ?? 0),
          angle: predicted.angle + (offset?.dAngle ?? 0),
          speed: predicted.speed,
        };
        drawTank(this.ctx, ts, color);
      } else {
        // Remote tank: render from interpolation
        const ts: TankState = { id: sessionId, x: remote.x, y: remote.y, angle: remote.angle, speed: remote.speed };
        drawTank(this.ctx, ts, color);
      }
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
