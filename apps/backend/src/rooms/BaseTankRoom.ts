import { Room } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import { TankRoomState, Tank, Bullet, Powerup, Missile, ActiveEffect } from './TankRoomState';
import {
  SERVER_TICK_HZ,
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
  BULLET_LIFETIME_SECONDS,
  MAX_BULLETS_PER_TANK,
  LIVES_PER_GAME,
  POWERUP_SPAWN_INTERVAL_MIN_S,
  POWERUP_SPAWN_INTERVAL_MAX_S,
  POWERUP_MAX_ON_FIELD,
  POWERUP_COLLECTION_RADIUS,
  MISSILE_LIFETIME_SECONDS,
  MISSILE_RADIUS,
  PowerupType,
  BULLET_FIRE_COOLDOWN_MS,
} from '@tankbet/game-engine/constants';
import {
  updateTank,
  updateBullet,
  checkBulletTankCollision,
  createBullet,
  clampTankToMaze,
  collideTankWithWalls,
  extractWallEndpoints,
  collideTankWithEndpoints,
  bulletCrossesWall,
  reflectBulletAtWall,
  createMissile,
  updateMissile,
  checkCircleTankCollision,
} from '@tankbet/game-engine/physics';
import type { InputState, WallSegment, Vec2, TankState, MissileState } from '@tankbet/game-engine/physics';
import { generateMaze, mazeToSegments, getSpawnPosition } from '@tankbet/game-engine/maze';
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
  protected bulletAges = new Map<string, number>();
  protected missileTargets = new Map<string, string>();
  protected powerupSpawnTimer = 0;
  protected nextPowerupSpawnIn = 10;
  protected powerupCells: Array<{ x: number; y: number }> = [];
  protected sessionToUserId = new Map<string, string>();
  protected sessionToPlayerIdx = new Map<string, 0 | 1>();
  protected lastFiredAt = new Map<string, number>();

  protected initRoom(): void {
    this.state = new TankRoomState();

    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.wallSegments = mazeToSegments(this.maze);
    this.wallEndpoints = extractWallEndpoints(this.wallSegments);
    this.mazeWidth = MAZE_COLS * CELL_SIZE;
    this.mazeHeight = MAZE_ROWS * CELL_SIZE;

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

    const spawn = getSpawnPosition(this.maze, playerIdx);
    const tank = new Tank();
    tank.id = userId;
    tank.x = spawn.x;
    tank.y = spawn.y;
    tank.angle = playerIdx === 0 ? 0 : 180;
    tank.alive = true;
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

    // Clear all projectiles and their tracking data
    this.state.bullets.splice(0, this.state.bullets.length);
    this.state.missiles.splice(0, this.state.missiles.length);
    this.state.powerups.splice(0, this.state.powerups.length);
    this.bulletAges.clear();
    this.missileTargets.clear();
    this.lastFiredAt.clear();

    // Reset powerup timer
    this.powerupSpawnTimer = 0;
    this.nextPowerupSpawnIn =
      POWERUP_SPAWN_INTERVAL_MIN_S +
      Math.random() * (POWERUP_SPAWN_INTERVAL_MAX_S - POWERUP_SPAWN_INTERVAL_MIN_S);

    // Broadcast new maze to all connected clients
    this.broadcast('maze', { segments: this.wallSegments });

    // Respawn all tanks at their indexed spawn positions
    this.state.tanks.forEach((tank, sessionId) => {
      const playerIdx = this.sessionToPlayerIdx.get(sessionId) ?? 0;
      const spawn = getSpawnPosition(this.maze!, playerIdx);
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
      const canFire = (now - (this.lastFiredAt.get(sessionId) ?? 0)) >= BULLET_FIRE_COOLDOWN_MS;
      if (input.fire && canFire) {
        this.lastFiredAt.set(sessionId, now);

        let missileEffectIdx = -1;
        for (let i = 0; i < tank.effects.length; i++) {
          const e = tank.effects[i];
          if (e && e.type === PowerupType.TARGETING_MISSILE && e.remainingAmmo > 0) {
            missileEffectIdx = i;
            break;
          }
        }

        if (missileEffectIdx >= 0) {
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

          const effect = tank.effects[missileEffectIdx]!;
          effect.remainingAmmo--;
          if (effect.remainingAmmo <= 0) {
            tank.effects.splice(missileEffectIdx, 1);
          }
        } else {
          const bulletCount = this.state.bullets.filter((b) => b.ownerId === tank.id).length;
          if (bulletCount < MAX_BULLETS_PER_TANK) {
            this.bulletIdCounter++;
            const bulletState = createBullet(`b-${this.bulletIdCounter}`, tankState);
            const bullet = new Bullet();
            bullet.id = bulletState.id;
            bullet.ownerId = bulletState.ownerId;
            bullet.x = bulletState.x;
            bullet.y = bulletState.y;
            bullet.vx = bulletState.vx;
            bullet.vy = bulletState.vy;
            this.bulletAges.set(bullet.id, 0);
            this.state.bullets.push(bullet);
          }
        }
      }

      const effects: ActiveEffectData[] = Array.from({ length: tank.effects.length }, (_, i) => ({
        type: tank.effects[i]!.type,
        remainingTime: tank.effects[i]!.remainingTime,
        remainingAmmo: tank.effects[i]!.remainingAmmo,
      }));
      const _stats = resolveStats(effects);

      const updated = updateTank(tankState, { ...input, fire: false }, dt);
      const clamped = clampTankToMaze(updated, this.mazeWidth, this.mazeHeight);
      const { tank: collided } = collideTankWithWalls(clamped, tankState, this.wallSegments);
      const shielded = collideTankWithEndpoints(collided, this.wallEndpoints);
      tank.x = shielded.x;
      tank.y = shielded.y;
      tank.angle = shielded.angle;
    });

    // 2. Advance bullets
    const bulletsToRemove: number[] = [];
    for (let i = 0; i < this.state.bullets.length; i++) {
      const bullet = this.state.bullets[i];
      if (!bullet) continue;
      const bulletState = {
        id: bullet.id,
        ownerId: bullet.ownerId,
        x: bullet.x,
        y: bullet.y,
        vx: bullet.vx,
        vy: bullet.vy,
        age: this.bulletAges.get(bullet.id) ?? 0,
      };

      const prevX = bulletState.x;
      const prevY = bulletState.y;
      const advanced = updateBullet(bulletState, dt);

      if (advanced.age >= BULLET_LIFETIME_SECONDS) {
        bulletsToRemove.push(i);
        continue;
      }

      let reflected = advanced;
      for (const wall of this.wallSegments) {
        const { crossed, hitX, hitY } = bulletCrossesWall(prevX, prevY, reflected.x, reflected.y, wall);
        if (crossed) {
          reflected = reflectBulletAtWall(reflected, wall, hitX, hitY);
          break;
        }
      }

      let hitTank = false;
      this.state.tanks.forEach((tank, sessionId) => {
        if (hitTank || !tank.alive) return;
        const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };
        if (checkBulletTankCollision(reflected, ts)) {
          hitTank = true;
          bulletsToRemove.push(i);
          this.onBulletHitTank(sessionId);
        }
      });

      if (!hitTank) {
        bullet.x = reflected.x;
        bullet.y = reflected.y;
        bullet.vx = reflected.vx;
        bullet.vy = reflected.vy;
        this.bulletAges.set(bullet.id, advanced.age);
      }
    }

    const uniqueBulletRemove = [...new Set(bulletsToRemove)].sort((a, b) => b - a);
    for (const idx of uniqueBulletRemove) {
      const b = this.state.bullets[idx];
      if (b) this.bulletAges.delete(b.id);
      this.state.bullets.splice(idx, 1);
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
      const eps = MISSILE_RADIUS + 1;
      let rx = updated.x;
      let ry = updated.y;
      let rvx = updated.vx;
      let rvy = updated.vy;
      for (const wall of this.wallSegments) {
        const { crossed, hitX, hitY } = bulletCrossesWall(ms.x, ms.y, rx, ry, wall);
        if (crossed) {
          if (wall.x1 === wall.x2) {
            rvx = -rvx;
            rx = rvx > 0 ? hitX + eps : hitX - eps;
            ry = hitY;
          } else {
            rvy = -rvy;
            ry = rvy > 0 ? hitY + eps : hitY - eps;
            rx = hitX;
          }
          break;
        }
      }

      let hitTank = false;
      this.state.tanks.forEach((tank, sessionId) => {
        if (hitTank || !tank.alive) return;
        const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };
        if (checkCircleTankCollision(rx, ry, MISSILE_RADIUS, ts)) {
          hitTank = true;
          missilesToRemove.push(i);
          this.onBulletHitTank(sessionId);
        }
      });

      if (!hitTank) {
        missile.x = rx;
        missile.y = ry;
        missile.vx = rvx;
        missile.vy = rvy;
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
