import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import { TankRoomState, Tank, Bullet } from './TankRoomState';
import {
  SERVER_TICK_HZ,
  SERVER_PATCH_HZ,
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
  LIVES_PER_GAME,
  BULLET_FIRE_COOLDOWN_MS,
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
import type { InputState, WallSegment, Vec2, TankState } from '@tankbet/game-engine/physics';
import { generateMaze, mazeToSegments, getSpawnPositions } from '@tankbet/game-engine/maze';
import type { Maze } from '@tankbet/game-engine/maze';

interface InputMessage {
  keys: InputState;
}

export abstract class BaseTankRoom extends Room<{ state: TankRoomState }> {
  declare state: TankRoomState;
  protected maze: Maze | null = null;
  protected wallSegments: WallSegment[] = [];
  protected wallEndpoints: Vec2[] = [];
  protected mazeWidth = 0;
  protected mazeHeight = 0;
  protected pendingInputs = new Map<string, { keys: InputState }>();
  protected playerCount = 0;
  protected bulletIdCounter = 0;
  protected sessionToUserId = new Map<string, string>();
  protected sessionToPlayerIdx = new Map<string, 0 | 1>();
  protected spawnPositions: [Vec2, Vec2] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  protected lastFiredAt = new Map<string, number>();
  // Internal physics state for bullets (velocity/age not in schema — only x/y/ownerId are synced)
  protected bulletPhysics = new Map<string, { vx: number; vy: number; age: number }>();
  // Accumulator to decouple patch rate from tick rate
  private patchAccumulator = 0;
  private readonly patchInterval = 1 / SERVER_PATCH_HZ;

  protected initRoom(): void {
    this.state = new TankRoomState();

    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.wallSegments = mazeToSegments(this.maze);
    this.wallEndpoints = extractWallEndpoints(this.wallSegments);
    this.mazeWidth = MAZE_COLS * CELL_SIZE;
    this.mazeHeight = MAZE_ROWS * CELL_SIZE;
    this.spawnPositions = getSpawnPositions(this.maze);

    // Disable automatic patching — we call broadcastPatch() manually at the
    // end of each tick to guarantee exactly 1 patch per simulation step.
    // When patchRate === simulationInterval, Node.js timer drift causes
    // two ticks to sometimes fire before one patch, doubling the error.
    this.patchRate = null;

    this.onMessage('input', (client: Client, message: InputMessage) => {
      this.pendingInputs.set(client.sessionId, { keys: message.keys });
    });
  }

  protected spawnPlayer(client: Client, userId: string): void {
    const playerIdx: 0 | 1 = this.playerCount === 0 ? 0 : 1;
    this.playerCount++;
    this.sessionToUserId.set(client.sessionId, userId);
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
    this.state.lives.set(client.sessionId, LIVES_PER_GAME);

    client.send('maze', { segments: this.wallSegments });
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

    // Clear all projectiles
    this.state.bullets.clear();
    this.bulletPhysics.clear();
    this.lastFiredAt.clear();

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

  private tick(_dt: number): void {
    // Use fixed timestep to match client prediction exactly (Gambetta reconciliation
    // requires identical physics on both sides). The variable dt from setSimulationInterval
    // causes drift that appears as micro-stutters during reconciliation.
    const dt = 1 / SERVER_TICK_HZ;
    if (this.state.phase !== 'playing') return;

    this.state.serverTick++;

    // 1. Process pending inputs → move tanks + fire
    this.state.tanks.forEach((tank, sessionId) => {
      if (!tank.alive) return;

      const pending = this.pendingInputs.get(sessionId);
      if (!pending) return;

      const input = pending.keys;

      const tankState: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };

      // Handle firing
      const now = Date.now();
      const lastFired = this.lastFiredAt.get(sessionId) ?? 0;

      // Count bullets owned by this tank in the schema map
      let bulletCount = 0;
      this.state.bullets.forEach((b) => { if (b.ownerId === tank.id) bulletCount++; });

      // canFireBullet checks both cooldown and max bullet count
      const canFire = canFireBullet(now, lastFired, bulletCount);

      if (input.fire && canFire) {
        this.bulletIdCounter++;
        const bulletState = createBullet(`b-${this.bulletIdCounter}`, tankState, this.wallSegments);

        if (bulletState) {
          this.lastFiredAt.set(sessionId, now);

          const schemaBullet = new Bullet();
          schemaBullet.x = bulletState.x;
          schemaBullet.y = bulletState.y;
          schemaBullet.ownerId = bulletState.ownerId;
          this.state.bullets.set(bulletState.id, schemaBullet);

          // Store velocity/age in the internal map for physics simulation
          this.bulletPhysics.set(bulletState.id, {
            vx: bulletState.vx,
            vy: bulletState.vy,
            age: bulletState.age,
          });
        }
      }

      const updated = updateTank(tankState, { ...input, fire: false }, dt);
      const clamped = clampTankToMaze(updated, this.mazeWidth, this.mazeHeight);
      const { tank: collided } = collideTankWithWalls(clamped, tankState, this.wallSegments);
      const shielded = collideTankWithEndpoints(collided, this.wallEndpoints);
      tank.x = shielded.x;
      tank.y = shielded.y;
      tank.angle = shielded.angle;
      tank.speed = updated.speed;
    });

    // 2. Advance bullets (schema-based)
    const bulletsToRemove: string[] = [];
    this.state.bullets.forEach((schemaBullet, bulletId) => {
      const physics = this.bulletPhysics.get(bulletId);
      if (!physics) {
        bulletsToRemove.push(bulletId);
        return;
      }

      const bulletState = {
        id: bulletId,
        ownerId: schemaBullet.ownerId,
        x: schemaBullet.x,
        y: schemaBullet.y,
        vx: physics.vx,
        vy: physics.vy,
        age: physics.age,
      };

      const advanced = advanceBullet(bulletState, dt, this.wallSegments);
      if (!advanced) {
        bulletsToRemove.push(bulletId);
        return;
      }

      let hitTank = false;
      this.state.tanks.forEach((tank, sessionId) => {
        if (hitTank || !tank.alive) return;
        const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };
        if (checkBulletTankCollision(advanced, ts, this.wallSegments)) {
          hitTank = true;
          bulletsToRemove.push(bulletId);
          this.onBulletHitTank(sessionId);
        }
      });

      if (!hitTank) {
        // Update schema positions (synced to clients)
        schemaBullet.x = advanced.x;
        schemaBullet.y = advanced.y;
        // Update internal physics state
        physics.vx = advanced.vx;
        physics.vy = advanced.vy;
        physics.age = advanced.age;
      }
    });

    for (const bulletId of bulletsToRemove) {
      this.state.bullets.delete(bulletId);
      this.bulletPhysics.delete(bulletId);
    }

    // Send patches at SERVER_PATCH_HZ (may be lower than tick rate to reduce bandwidth)
    this.patchAccumulator += dt;
    if (this.patchAccumulator >= this.patchInterval) {
      this.patchAccumulator -= this.patchInterval;
      this.broadcastPatch();
    }
  }
}
