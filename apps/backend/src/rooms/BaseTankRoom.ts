import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import { TankRoomState, Tank, Powerup, Missile, ActiveEffect } from './TankRoomState';
import {
  SERVER_TICK_HZ,
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
  LIVES_PER_GAME,
  POWERUP_SPAWN_INTERVAL_MIN_S,
  POWERUP_SPAWN_INTERVAL_MAX_S,
  POWERUP_MAX_ON_FIELD,
  POWERUP_COLLECTION_RADIUS,
  MISSILE_LIFETIME_SECONDS,
  MISSILE_RADIUS,
  PowerupType,
  BULLET_FIRE_COOLDOWN_MS,
  MISSILE_FIRE_EXTRA_COOLDOWN_MS,
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
  bulletCrossesWall,
  reflectBulletAtWall,
  advanceBullet,
  createMissile,
  updateMissile,
  checkCircleTankCollision,
} from '@tankbet/game-engine/physics';
import type { InputState, WallSegment, Vec2, TankState, BulletState, MissileState } from '@tankbet/game-engine/physics';
import { generateMaze, mazeToSegments, getSpawnPositions } from '@tankbet/game-engine/maze';
import type { Maze } from '@tankbet/game-engine/maze';
import { resolveStats, randomPowerupType } from '@tankbet/game-engine/powerups';
import type { ActiveEffectData } from '@tankbet/game-engine/powerups';

interface InputMessage {
  keys: InputState;
  seq: number;
}

export abstract class BaseTankRoom extends Room<{ state: TankRoomState }> {
  declare state: TankRoomState;
  protected maze: Maze | null = null;
  protected wallSegments: WallSegment[] = [];
  protected wallEndpoints: Vec2[] = [];
  protected mazeWidth = 0;
  protected mazeHeight = 0;
  protected pendingInputs = new Map<string, InputState>();
  protected playerCount = 0;
  protected bulletIdCounter = 0;
  protected missileIdCounter = 0;
  protected powerupIdCounter = 0;
  protected bullets: BulletState[] = [];
  protected missileTargets = new Map<string, string>();
  protected powerupSpawnTimer = 0;
  protected nextPowerupSpawnIn = 10;
  protected powerupCells: Array<{ x: number; y: number }> = [];
  protected sessionToUserId = new Map<string, string>();
  protected sessionToPlayerIdx = new Map<string, 0 | 1>();
  protected spawnPositions: [Vec2, Vec2] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  protected lastFiredAt = new Map<string, number>();

  protected initRoom(): void {
    this.state = new TankRoomState();

    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.wallSegments = mazeToSegments(this.maze);
    this.wallEndpoints = extractWallEndpoints(this.wallSegments);
    this.mazeWidth = MAZE_COLS * CELL_SIZE;
    this.mazeHeight = MAZE_ROWS * CELL_SIZE;
    this.spawnPositions = getSpawnPositions(this.maze);

    for (let row = 1; row < MAZE_ROWS - 1; row++) {
      for (let col = 1; col < MAZE_COLS - 1; col++) {
        this.powerupCells.push({
          x: col * CELL_SIZE + CELL_SIZE / 2,
          y: row * CELL_SIZE + CELL_SIZE / 2,
        });
      }
    }
    this.nextPowerupSpawnIn =
      POWERUP_SPAWN_INTERVAL_MIN_S +
      Math.random() * (POWERUP_SPAWN_INTERVAL_MAX_S - POWERUP_SPAWN_INTERVAL_MIN_S);

    this.patchRate = 1000 / SERVER_TICK_HZ;

    this.onMessage('input', (client: Client, message: InputMessage) => {
      this.pendingInputs.set(client.sessionId, message.keys);
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
    this.state.tanks.set(client.sessionId, tank);
    this.state.lives.set(client.sessionId, LIVES_PER_GAME);

    client.send('maze', { segments: this.wallSegments });
    client.send('bullet:sync', this.bullets);
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

    // Clear all projectiles and their tracking data
    this.bullets = [];
    this.broadcast('bullet:clear');
    this.state.missiles.splice(0, this.state.missiles.length);
    this.state.powerups.splice(0, this.state.powerups.length);
    this.missileTargets.clear();
    this.lastFiredAt.clear();

    // Reset powerup timer
    this.powerupSpawnTimer = 0;
    this.nextPowerupSpawnIn =
      POWERUP_SPAWN_INTERVAL_MIN_S +
      Math.random() * (POWERUP_SPAWN_INTERVAL_MAX_S - POWERUP_SPAWN_INTERVAL_MIN_S);

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
      tank.effects.splice(0, tank.effects.length);
    });

    this.state.phase = 'playing';
  }

  protected abstract onBulletHitTank(killedSessionId: string): void;

  private tick(dt: number): void {
    if (this.state.phase !== 'playing') return;

    // 1. Process pending inputs → move tanks
    this.state.tanks.forEach((tank, sessionId) => {
      if (!tank.alive) return;

      const input = this.pendingInputs.get(sessionId);
      if (!input) return;

      const tankState: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };

      // Handle firing — weapon powerup takes priority over normal bullets
      const now = Date.now();
      const lastFired = this.lastFiredAt.get(sessionId) ?? 0;
      const bulletCount = this.bullets.filter((b) => b.ownerId === tank.id).length;
      // canFireBullet checks both cooldown and max bullet count
      const canFire = canFireBullet(now, lastFired, bulletCount);

      // Missile path only needs cooldown (not bullet count), so check separately
      let missileEffectIdx = -1;
      if (input.fire) {
        for (let i = 0; i < tank.effects.length; i++) {
          const e = tank.effects[i];
          if (e && e.type === PowerupType.TARGETING_MISSILE && e.remainingAmmo > 0) {
            missileEffectIdx = i;
            break;
          }
        }
      }

      const hasMissileAmmo = missileEffectIdx >= 0;
      // Missiles share the cooldown but not the bullet count limit
      const cooldownReady = (now - lastFired) >= BULLET_FIRE_COOLDOWN_MS;

      if (input.fire && hasMissileAmmo && cooldownReady) {
        // Add extra cooldown after missile to prevent accidental bullet fire
        this.lastFiredAt.set(sessionId, now + MISSILE_FIRE_EXTRA_COOLDOWN_MS);

        let enemyId = '';
        this.state.tanks.forEach((otherTank, otherSessionId) => {
          if (otherSessionId !== sessionId) enemyId = otherTank.id;
        });

        this.missileIdCounter++;
        const ms: MissileState = createMissile(`m-${this.missileIdCounter}`, tankState, enemyId);
        const missile = new Missile();
        missile.id = ms.id;
        missile.ownerId = ms.ownerId;
        missile.x = ms.x;
        missile.y = ms.y;
        missile.vx = ms.vx;
        missile.vy = ms.vy;
        missile.age = 0;
        this.missileTargets.set(missile.id, ms.initialTargetId);
        this.state.missiles.push(missile);

        const effect = tank.effects[missileEffectIdx];
        if (effect) {
          effect.remainingAmmo--;
          if (effect.remainingAmmo <= 0) {
            tank.effects.splice(missileEffectIdx, 1);
          }
        }
      } else if (input.fire && canFire) {
        this.lastFiredAt.set(sessionId, now);
        this.bulletIdCounter++;
        const bulletState = createBullet(`b-${this.bulletIdCounter}`, tankState);
        this.bullets.push(bulletState);
        this.broadcast('bullet:fire', {
          id: bulletState.id,
          ownerId: bulletState.ownerId,
          x: bulletState.x,
          y: bulletState.y,
          vx: bulletState.vx,
          vy: bulletState.vy,
        });
      }

      const effects: ActiveEffectData[] = [];
      for (let i = 0; i < tank.effects.length; i++) {
        const eff = tank.effects[i];
        if (eff) {
          effects.push({
            type: eff.type,
            remainingTime: eff.remainingTime,
            remainingAmmo: eff.remainingAmmo,
          });
        }
      }
      const _stats = resolveStats(effects);

      const updated = updateTank(tankState, { ...input, fire: false }, dt);
      const clamped = clampTankToMaze(updated, this.mazeWidth, this.mazeHeight);
      const { tank: collided } = collideTankWithWalls(clamped, tankState, this.wallSegments);
      const shielded = collideTankWithEndpoints(collided, this.wallEndpoints);
      tank.x = shielded.x;
      tank.y = shielded.y;
      tank.angle = shielded.angle;
    });

    // 2. Advance bullets (plain array, synced via events)
    const bulletsToRemove: number[] = [];
    for (let i = 0; i < this.bullets.length; i++) {
      const bullet = this.bullets[i];
      if (!bullet) continue;

      const prevVx = bullet.vx;
      const prevVy = bullet.vy;
      const advanced = advanceBullet(bullet, dt, this.wallSegments);
      if (!advanced) {
        bulletsToRemove.push(i);
        this.broadcast('bullet:remove', { id: bullet.id });
        continue;
      }

      let hitTank = false;
      this.state.tanks.forEach((tank, sessionId) => {
        if (hitTank || !tank.alive) return;
        const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };
        if (checkBulletTankCollision(advanced, ts)) {
          hitTank = true;
          bulletsToRemove.push(i);
          this.broadcast('bullet:remove', { id: bullet.id });
          this.onBulletHitTank(sessionId);
        }
      });

      if (!hitTank) {
        // Detect bounce: velocity direction changed
        if (advanced.vx !== prevVx || advanced.vy !== prevVy) {
          this.broadcast('bullet:bounce', {
            id: advanced.id,
            x: advanced.x,
            y: advanced.y,
            vx: advanced.vx,
            vy: advanced.vy,
          });
        }
        this.bullets[i] = advanced;
      }
    }

    const uniqueBulletRemove = [...new Set(bulletsToRemove)].sort((a, b) => b - a);
    for (const idx of uniqueBulletRemove) {
      this.bullets.splice(idx, 1);
    }

    // 3. Advance missiles
    const tankSnapshots: TankState[] = [];
    this.state.tanks.forEach((tank) => {
      if (tank.alive) {
        tankSnapshots.push({ id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 });
      }
    });

    const missilesToRemove: number[] = [];
    for (let i = 0; i < this.state.missiles.length; i++) {
      const missile = this.state.missiles[i];
      if (!missile) continue;

      const ms: MissileState = {
        id: missile.id,
        ownerId: missile.ownerId,
        x: missile.x,
        y: missile.y,
        vx: missile.vx,
        vy: missile.vy,
        age: missile.age,
        initialTargetId: this.missileTargets.get(missile.id) ?? '',
      };

      const updated = updateMissile(ms, tankSnapshots, this.wallSegments, dt);

      if (updated.age >= MISSILE_LIFETIME_SECONDS) {
        missilesToRemove.push(i);
        continue;
      }

      // Missiles bounce off walls (walls are indestructible).
      // Smart steering means this should rarely trigger.
      let missileResult: BulletState = {
        id: missile.id,
        ownerId: missile.ownerId,
        x: updated.x,
        y: updated.y,
        vx: updated.vx,
        vy: updated.vy,
        age: updated.age,
      };
      for (const wall of this.wallSegments) {
        const { crossed, hitX, hitY } = bulletCrossesWall(ms.x, ms.y, missileResult.x, missileResult.y, wall);
        if (crossed) {
          missileResult = reflectBulletAtWall(missileResult, wall, hitX, hitY, MISSILE_RADIUS);
          break;
        }
      }

      let hitTank = false;
      this.state.tanks.forEach((tank, sessionId) => {
        if (hitTank || !tank.alive) return;
        const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };
        if (checkCircleTankCollision(missileResult.x, missileResult.y, MISSILE_RADIUS, ts)) {
          hitTank = true;
          missilesToRemove.push(i);
          this.onBulletHitTank(sessionId);
        }
      });

      if (!hitTank) {
        missile.x = missileResult.x;
        missile.y = missileResult.y;
        missile.vx = missileResult.vx;
        missile.vy = missileResult.vy;
        missile.age = updated.age;
      }
    }

    const uniqueMissileRemove = [...new Set(missilesToRemove)].sort((a, b) => b - a);
    for (const idx of uniqueMissileRemove) {
      const m = this.state.missiles[idx];
      if (m) this.missileTargets.delete(m.id);
      this.state.missiles.splice(idx, 1);
    }

    // 4. Check powerup collection
    const powerupsToRemove: number[] = [];
    for (let pi = 0; pi < this.state.powerups.length; pi++) {
      const powerup = this.state.powerups[pi];
      if (!powerup) continue;

      this.state.tanks.forEach((tank) => {
        if (!tank.alive) return;
        if (tank.effects.length > 0) return;

        const dx = tank.x - powerup.x;
        const dy = tank.y - powerup.y;
        if (dx * dx + dy * dy <= POWERUP_COLLECTION_RADIUS * POWERUP_COLLECTION_RADIUS) {
          const effect = new ActiveEffect();
          effect.type = powerup.type;
          effect.remainingTime = -1;
          effect.remainingAmmo = 1;
          tank.effects.push(effect);
          powerupsToRemove.push(pi);
        }
      });
    }

    const uniquePowerupRemove = [...new Set(powerupsToRemove)].sort((a, b) => b - a);
    for (const idx of uniquePowerupRemove) {
      this.state.powerups.splice(idx, 1);
    }

    // 5. Powerup spawn timer
    this.powerupSpawnTimer += dt;
    if (
      this.powerupSpawnTimer >= this.nextPowerupSpawnIn &&
      this.state.powerups.length < POWERUP_MAX_ON_FIELD
    ) {
      this.spawnPowerup();
      this.powerupSpawnTimer = 0;
      this.nextPowerupSpawnIn =
        POWERUP_SPAWN_INTERVAL_MIN_S +
        Math.random() * (POWERUP_SPAWN_INTERVAL_MAX_S - POWERUP_SPAWN_INTERVAL_MIN_S);
    }
  }

  protected spawnPowerup(): void {
    const tankPositions = Array.from(this.state.tanks.values())
      .filter((t) => t.alive)
      .map((t) => ({ x: t.x, y: t.y }));

    const occupiedCells = new Set<string>();
    for (let i = 0; i < this.state.powerups.length; i++) {
      const p = this.state.powerups[i];
      if (p) {
        occupiedCells.add(`${Math.floor(p.x / CELL_SIZE)},${Math.floor(p.y / CELL_SIZE)}`);
      }
    }

    const candidates = [...this.powerupCells].sort(() => Math.random() - 0.5);
    const minDistSq = (CELL_SIZE * 2) * (CELL_SIZE * 2);

    for (const cell of candidates) {
      const cellKey = `${Math.floor(cell.x / CELL_SIZE)},${Math.floor(cell.y / CELL_SIZE)}`;
      if (occupiedCells.has(cellKey)) continue;

      const tooClose = tankPositions.some((t) => {
        const dx = t.x - cell.x;
        const dy = t.y - cell.y;
        return dx * dx + dy * dy < minDistSq;
      });
      if (tooClose) continue;

      this.powerupIdCounter++;
      const powerup = new Powerup();
      powerup.id = `pu-${this.powerupIdCounter}`;
      powerup.type = randomPowerupType();
      powerup.x = cell.x;
      powerup.y = cell.y;
      this.state.powerups.push(powerup);
      return;
    }
  }
}
