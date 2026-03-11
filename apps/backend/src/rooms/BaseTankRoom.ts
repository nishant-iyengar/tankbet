import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import { TankRoomState, Tank } from './TankRoomState';
import {
  SERVER_TICK_HZ,
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
  LIVES_PER_GAME,
  POSITION_HISTORY_SIZE,
  LAG_COMP_MAX_REWIND_MS,
  REMOTE_INTERP_DELAY_MS,
} from '@tankbet/game-engine/constants';
import {
  updateTank,
  checkBulletTankCollision,
  canFireBullet,
  createBullet,
  clampTankToMaze,
  collideTankWithWalls,
  extractWallEndpoints,
  collideTankWithEndpoints,
  advanceBullet,
} from '@tankbet/game-engine/physics';
import type { InputState, WallSegment, Vec2, TankState, BulletState } from '@tankbet/game-engine/physics';
import { generateMaze, mazeToSegments, getSpawnPositions } from '@tankbet/game-engine/maze';
import type { Maze } from '@tankbet/game-engine/maze';

interface InputMessage {
  keys: InputState;
  tick: number;
}

interface PositionHistoryEntry {
  tick: number;
  time: number;
  x: number;
  y: number;
  angle: number;
}

export abstract class BaseTankRoom extends Room<{ state: TankRoomState }> {
  declare state: TankRoomState;
  protected maze: Maze | null = null;
  protected wallSegments: WallSegment[] = [];
  protected wallEndpoints: Vec2[] = [];
  protected mazeWidth = 0;
  protected mazeHeight = 0;
  protected pendingInputs = new Map<string, { keys: InputState }>();
  // Per-session tick tracking: last client tick received + server ticks since then
  protected lastClientTick = new Map<string, number>();
  protected ticksSinceInput = new Map<string, number>();
  protected playerCount = 0;
  protected livesPerGame = LIVES_PER_GAME;
  protected bulletIdCounter = 0;
  protected sessionToUserId = new Map<string, string>();
  protected sessionToPlayerIdx = new Map<string, 0 | 1>();
  protected spawnPositions: [Vec2, Vec2] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  protected lastFiredAt = new Map<string, number>();
  // Event-driven bullets — full physics state stored server-side, events broadcast to clients
  protected bullets: BulletState[] = [];

  // Lag compensation — position history ring buffer per session
  protected positionHistory = new Map<string, PositionHistoryEntry[]>();
  protected clientRtt = new Map<string, number>();
  private serverTick = 0;
  // Reverse lookup: userId → sessionId (for finding shooter's session from bullet.ownerId)
  protected userIdToSession = new Map<string, string>();

  protected initRoom(): void {
    this.state = new TankRoomState();

    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.wallSegments = mazeToSegments(this.maze);
    this.wallEndpoints = extractWallEndpoints(this.wallSegments);
    this.mazeWidth = MAZE_COLS * CELL_SIZE;
    this.mazeHeight = MAZE_ROWS * CELL_SIZE;
    this.spawnPositions = getSpawnPositions(this.maze);

    // Decouple patch rate from physics tick rate. Physics runs at 60Hz for
    // accuracy, but network patches are sent at ~30Hz (every ~33ms). Colyseus
    // accumulates all state changes between patches and sends the net result.
    this.patchRate = 33;

    this.onMessage('input', (client: Client, message: InputMessage) => {
      this.pendingInputs.set(client.sessionId, { keys: message.keys });
      this.lastClientTick.set(client.sessionId, message.tick);
      this.ticksSinceInput.set(client.sessionId, 1);
    });

    // Lag compensation: ping/pong RTT measurement
    this.onMessage('ping', (client: Client, data: { clientTime: number }) => {
      client.send('pong', { clientTime: data.clientTime });
    });

    this.onMessage('rtt', (client: Client, data: { rtt: number }) => {
      // Clamp to reasonable range
      const rtt = Math.max(0, Math.min(data.rtt, 2000));
      this.clientRtt.set(client.sessionId, rtt);
    });
  }

  protected spawnPlayer(client: Client, userId: string): void {
    const playerIdx: 0 | 1 = this.playerCount === 0 ? 0 : 1;
    this.playerCount++;
    this.sessionToUserId.set(client.sessionId, userId);
    this.userIdToSession.set(userId, client.sessionId);
    this.sessionToPlayerIdx.set(client.sessionId, playerIdx);

    if (!this.maze) return;

    const spawn = this.spawnPositions[playerIdx];
    const tank = new Tank();
    tank.id = userId;
    tank.x = spawn.x;
    tank.y = spawn.y;
    tank.angle = playerIdx === 0 ? 0 : 180;
    tank.alive = true;
    tank.speed = 0;
    this.state.tanks.set(client.sessionId, tank);
    this.state.lives.set(client.sessionId, this.livesPerGame);

    client.send('maze', { segments: this.wallSegments });

    // Send current bullet state so late joiners / reconnects see existing bullets
    if (this.bullets.length > 0) {
      client.send('bullet:sync', this.bullets);
    }
  }

  protected startGameLoop(): void {
    this.setSimulationInterval((dt) => this.tick(dt / 1000), 1000 / SERVER_TICK_HZ);
  }

  protected startNewBattle(): void {
    if (!this.maze) return;

    // Generate a fresh maze
    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.wallSegments = mazeToSegments(this.maze);
    this.wallEndpoints = extractWallEndpoints(this.wallSegments);

    // Clear all projectiles and lag comp history (tanks teleport to new positions)
    this.bullets = [];
    this.lastFiredAt.clear();
    this.positionHistory.clear();
    this.broadcast('bullet:clear');

    // Pick new random spawn positions for the fresh maze
    this.spawnPositions = getSpawnPositions(this.maze);

    // Broadcast new maze to all connected clients
    this.broadcast('maze', { segments: this.wallSegments });

    // Respawn all tanks at their indexed spawn positions
    this.state.tanks.forEach((tank, sessionId) => {
      const playerIdx = this.sessionToPlayerIdx.get(sessionId) ?? 0;
      const spawn = this.spawnPositions[playerIdx];
      tank.x = spawn.x;
      tank.y = spawn.y;
      tank.angle = playerIdx === 0 ? 0 : 180;
      tank.alive = true;
      tank.speed = 0;
    });

    this.state.phase = 'playing';
  }

  protected abstract onBulletHitTank(killedSessionId: string): void;

  private getRewindPosition(sessionId: string, rewindMs: number): { x: number; y: number; angle: number } | null {
    const history = this.positionHistory.get(sessionId);
    if (!history || history.length === 0) return null;

    const targetTime = Date.now() - rewindMs;

    // If target time is before all history, use earliest entry
    if (targetTime <= history[0].time) {
      return { x: history[0].x, y: history[0].y, angle: history[0].angle };
    }

    // If target time is after all history, use latest entry (no rewind needed)
    if (targetTime >= history[history.length - 1].time) {
      const last = history[history.length - 1];
      return { x: last.x, y: last.y, angle: last.angle };
    }

    // Find bracketing entries and interpolate
    for (let i = history.length - 1; i > 0; i--) {
      if (history[i - 1].time <= targetTime && history[i].time >= targetTime) {
        const a = history[i - 1];
        const b = history[i];
        const span = b.time - a.time;
        const t = span > 0 ? (targetTime - a.time) / span : 1;
        return {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          angle: a.angle + (b.angle - a.angle) * t,
        };
      }
    }

    return null;
  }

  private tick(_dt: number): void {
    // Use fixed timestep to match client prediction exactly
    const dt = 1 / SERVER_TICK_HZ;
    if (this.state.phase !== 'playing') return;
    this.serverTick++;

    // 1. Process pending inputs → move tanks first, then fire.
    // Moving before firing ensures the bullet spawns from the barrel's
    // current position, not where it was last tick.
    this.state.tanks.forEach((tank, sessionId) => {
      if (!tank.alive) {
        // Clear stale input so it doesn't move the tank the instant it respawns
        this.pendingInputs.delete(sessionId);
        return;
      }

      const pending = this.pendingInputs.get(sessionId);
      if (!pending) return;

      const input = pending.keys;

      const prevTankState: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };

      // Move the tank first
      const updated = updateTank(prevTankState, { ...input, fire: false }, dt);
      const clamped = clampTankToMaze(updated, this.mazeWidth, this.mazeHeight);
      const { tank: collided } = collideTankWithWalls(clamped, prevTankState, this.wallSegments);
      const shielded = collideTankWithEndpoints(collided, this.wallEndpoints);
      // Quantize to float32 so server-side values match what clients receive
      // over the wire (schema uses float32). This prevents drift from float64
      // accumulation on the server vs float32 snapshots on the client.
      tank.x = Math.fround(shielded.x);
      tank.y = Math.fround(shielded.y);
      tank.angle = Math.fround(shielded.angle);
      tank.speed = Math.fround(updated.speed);

      // Record position history for lag compensation
      const history = this.positionHistory.get(sessionId);
      if (history) {
        history.push({ tick: this.serverTick, time: Date.now(), x: tank.x, y: tank.y, angle: tank.angle });
        if (history.length > POSITION_HISTORY_SIZE) {
          history.splice(0, history.length - POSITION_HISTORY_SIZE);
        }
      } else {
        this.positionHistory.set(sessionId, [{ tick: this.serverTick, time: Date.now(), x: tank.x, y: tank.y, angle: tank.angle }]);
      }

      // Estimate which client tick we've caught up to:
      // lastClientTick (from last input message) + server ticks processed since
      const baseTick = this.lastClientTick.get(sessionId) ?? 0;
      const elapsed = this.ticksSinceInput.get(sessionId) ?? 0;
      tank.lastInputSeq = baseTick + elapsed;
      this.ticksSinceInput.set(sessionId, elapsed + 1);

      // Fire from the updated position
      const now = Date.now();
      const lastFired = this.lastFiredAt.get(sessionId) ?? 0;

      let bulletCount = 0;
      for (const b of this.bullets) {
        if (b.ownerId === tank.id) bulletCount++;
      }

      const canFire = canFireBullet(now, lastFired, bulletCount);

      if (input.fire && canFire) {
        this.bulletIdCounter++;
        const movedTankState: TankState = { id: tank.id, x: shielded.x, y: shielded.y, angle: shielded.angle, speed: updated.speed };
        const bulletState = createBullet(`b-${this.bulletIdCounter}`, movedTankState, this.wallSegments);

        if (bulletState) {
          this.lastFiredAt.set(sessionId, now);
          this.bullets.push(bulletState);
          // Echo fireTick so client can match this bullet to its saved barrel tip
          const fireTick = this.lastClientTick.get(sessionId) ?? 0;
          this.broadcast('bullet:fire', {
            id: bulletState.id,
            ownerId: bulletState.ownerId,
            x: bulletState.x,
            y: bulletState.y,
            vx: bulletState.vx,
            vy: bulletState.vy,
            fireTick,
          });
        }
      }
    });

    // 2. Advance bullets (event-driven)
    const bulletsToRemove: string[] = [];
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      const prevVx = bullet.vx;
      const prevVy = bullet.vy;

      const advanced = advanceBullet(bullet, dt, this.wallSegments);
      if (!advanced) {
        bulletsToRemove.push(bullet.id);
        continue;
      }

      // Detect bounce: velocity direction changed
      const bounced = (Math.sign(advanced.vx) !== Math.sign(prevVx) && prevVx !== 0) ||
                      (Math.sign(advanced.vy) !== Math.sign(prevVy) && prevVy !== 0);

      if (bounced) {
        this.broadcast('bullet:bounce', {
          id: advanced.id,
          x: advanced.x,
          y: advanced.y,
          vx: advanced.vx,
          vy: advanced.vy,
        });
      }

      let hitTank = false;
      // Determine shooter's session for lag compensation
      const shooterSessionId = this.userIdToSession.get(advanced.ownerId) ?? '';
      const shooterRtt = this.clientRtt.get(shooterSessionId) ?? 0;
      const rewindMs = Math.min(REMOTE_INTERP_DELAY_MS + shooterRtt / 2, LAG_COMP_MAX_REWIND_MS);

      this.state.tanks.forEach((tank, sessionId) => {
        if (hitTank || !tank.alive) return;

        // For the target tank (not the shooter), use rewound position
        let targetX = tank.x;
        let targetY = tank.y;
        let targetAngle = tank.angle;

        if (sessionId !== shooterSessionId && rewindMs > 0) {
          const rewound = this.getRewindPosition(sessionId, rewindMs);
          if (rewound) {
            targetX = rewound.x;
            targetY = rewound.y;
            targetAngle = rewound.angle;
          }
        }

        const ts: TankState = { id: tank.id, x: targetX, y: targetY, angle: targetAngle, speed: 0 };
        if (checkBulletTankCollision(advanced, ts, this.wallSegments)) {
          hitTank = true;
          bulletsToRemove.push(advanced.id);
          this.onBulletHitTank(sessionId);
        }
      });

      if (!hitTank) {
        // Update the bullet in-place
        this.bullets[i] = advanced;
      }
    }

    // Remove dead bullets
    if (bulletsToRemove.length > 0) {
      const removeSet = new Set(bulletsToRemove);
      this.bullets = this.bullets.filter((b) => !removeSet.has(b.id));
      for (const id of bulletsToRemove) {
        this.broadcast('bullet:remove', { id });
      }
    }

    // Patches are sent automatically by Colyseus at patchRate (~30Hz / 33ms).
    // No manual broadcastPatch() needed — Colyseus accumulates changes.
  }
}
