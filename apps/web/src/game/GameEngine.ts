import type { Room } from '@colyseus/sdk';
import { getStateCallbacks } from '@colyseus/sdk';
import type { Client } from '@colyseus/sdk';
import type { InputState, TankState, BulletState } from '@tankbet/game-engine/physics';
import {
  shortestAngleDelta,
  advanceBullet,
} from '@tankbet/game-engine/physics';
import type { LineSegment } from '@tankbet/game-engine/maze';
import { PHYSICS_STEP } from '@tankbet/game-engine/constants';
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

  // Fixed-timestep accumulator for bullet physics
  private lastFrameTime = 0;
  private physicsAccumulator = 0;

  // Tank interpolation (all tanks, including local)
  private remoteTanks = new Map<string, RemoteTankState>();

  // Projectile state (event-driven)
  private activeBullets = new Map<string, BulletState>();
  // Previous positions for render interpolation
  private bulletPrevPositions = new Map<string, { x: number; y: number }>();

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
        bullet.x = data.x;
        bullet.y = data.y;
        bullet.vx = data.vx;
        bullet.vy = data.vy;
      }
    });

    room.onMessage('bullet:remove', (data: BulletRemoveEvent) => {
      this.activeBullets.delete(data.id);
      this.bulletPrevPositions.delete(data.id);
    });

    room.onMessage('bullet:clear', () => {
      this.activeBullets.clear();
      this.bulletPrevPositions.clear();
    });

    room.onMessage('bullet:sync', (bullets: BulletState[]) => {
      this.activeBullets.clear();
      for (const b of bullets) {
        this.activeBullets.set(b.id, { ...b });
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
  // Advance projectiles (event-driven, client-side simulation)
  // -------------------------------------------------------------------------

  private advanceProjectiles(): void {
    if (this.mazeSegments.length === 0) return;

    // Save previous positions for render interpolation
    for (const [id, bullet] of this.activeBullets) {
      this.bulletPrevPositions.set(id, { x: bullet.x, y: bullet.y });
    }

    // Advance bullets with wall bounce (fixed timestep matching server)
    const bulletToRemove: string[] = [];
    for (const [id, bullet] of this.activeBullets) {
      const advanced = advanceBullet(bullet, PHYSICS_STEP, this.mazeSegments);
      if (!advanced) {
        bulletToRemove.push(id);
        continue;
      }
      this.activeBullets.set(id, advanced);
    }
    for (const id of bulletToRemove) {
      this.activeBullets.delete(id);
      this.bulletPrevPositions.delete(id);
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

    // Fixed-timestep accumulator: step bullet physics at exactly PHYSICS_STEP
    // to match server determinism, then interpolate the remainder for smooth rendering.
    const perfNow = performance.now();
    if (this.lastFrameTime === 0) {
      this.lastFrameTime = perfNow;
    }
    const frameDt = Math.min((perfNow - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = perfNow;
    this.physicsAccumulator += frameDt;

    while (this.physicsAccumulator >= PHYSICS_STEP) {
      this.advanceProjectiles();
      this.physicsAccumulator -= PHYSICS_STEP;
    }

    // Interpolation alpha: how far between prev and current physics state
    const alpha = this.physicsAccumulator / PHYSICS_STEP;

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

    // Draw bullets with interpolation between previous and current physics positions
    for (const [id, bullet] of this.activeBullets) {
      const prev = this.bulletPrevPositions.get(id);
      if (prev) {
        drawBullet(this.ctx, {
          ...bullet,
          x: prev.x + (bullet.x - prev.x) * alpha,
          y: prev.y + (bullet.y - prev.y) * alpha,
        });
      } else {
        drawBullet(this.ctx, bullet);
      }
    }

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
