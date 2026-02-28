import { Room, ServerError } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import { TankRoomState, Tank, Bullet, Powerup, Missile, ActiveEffect } from './TankRoomState';
import {
  GAME_START_COUNTDOWN_SECONDS,
  GRACE_PERIOD_SECONDS,
  SERVER_TICK_HZ,
  MAZE_COLS,
  MAZE_ROWS,
  BULLET_LIFETIME_SECONDS,
  MAX_BULLETS_PER_TANK,
  LIVES_PER_GAME,
  PLEDGE_FEE_RATE,
  CELL_SIZE,
  RESPAWN_DELAY_MS,
  POWERUP_SPAWN_INTERVAL_MIN_S,
  POWERUP_SPAWN_INTERVAL_MAX_S,
  POWERUP_MAX_ON_FIELD,
  POWERUP_COLLECTION_RADIUS,
  MISSILE_LIFETIME_SECONDS,
  MISSILE_RADIUS,
  PowerupType,
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
import { generateMaze, mazeToSegments, getSpawnPosition, getRandomSpawn } from '@tankbet/game-engine/maze';
import type { Maze } from '@tankbet/game-engine/maze';
import { resolveStats, randomPowerupType } from '@tankbet/game-engine/powerups';
import type { ActiveEffectData } from '@tankbet/game-engine/powerups';
import { prisma } from '../prisma';

interface InputMessage {
  keys: InputState;
  seq: number;
}

export class TankRoom extends Room<TankRoomState> {
  maxClients = 2;
  gameDbId = '';
  private maze: Maze | null = null;
  private wallSegments: WallSegment[] = [];
  private wallEndpoints: Vec2[] = [];
  private mazeWidth = 0;
  private mazeHeight = 0;
  private pendingInputs = new Map<string, InputState>();
  private playerCount = 0;
  private bulletIdCounter = 0;
  private missileIdCounter = 0;
  private powerupIdCounter = 0;
  // Server-private state not synced to clients
  private bulletAges = new Map<string, number>();       // bulletId → age in seconds
  private missileTargets = new Map<string, string>();   // missileId → initialTargetId
  private powerupSpawnTimer = 0;
  private nextPowerupSpawnIn = 10; // seconds
  private powerupCells: Array<{ x: number; y: number }> = [];
  private sessionToUserId = new Map<string, string>();
  private allowedUserIds: string[] = [];
  private countdownStarted = false;

  onCreate(options: { gameId: string; player1Id: string; player2Id: string }): void {
    this.autoDispose = false;
    this.gameDbId = options.gameId;
    this.allowedUserIds = [options.player1Id, options.player2Id];
    this.setPrivate(true);
    this.lock();
    this.setState(new TankRoomState());

    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.wallSegments = mazeToSegments(this.maze);
    this.wallEndpoints = extractWallEndpoints(this.wallSegments);
    this.mazeWidth = MAZE_COLS * CELL_SIZE;
    this.mazeHeight = MAZE_ROWS * CELL_SIZE;

    // Pre-compute valid powerup spawn cells (interior cells, avoiding the outer border row/col)
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

    this.onMessage('input', (client: Client, message: InputMessage) => {
      this.pendingInputs.set(client.sessionId, message.keys);
    });
  }

  onJoin(client: Client, _options: unknown, auth?: { userId: string }): void {
    console.log(`[TankRoom] onJoin sessionId=${client.sessionId} userId=${auth?.userId} playerCount=${this.playerCount + 1}`);
    if (!auth || !this.allowedUserIds.includes(auth.userId)) {
      throw new ServerError(403, 'Not a participant in this game');
    }

    const playerIdx = this.playerCount as 0 | 1;
    this.playerCount++;
    this.sessionToUserId.set(client.sessionId, auth.userId);

    if (!this.maze) return;

    const spawn = getSpawnPosition(this.maze, playerIdx);
    const tank = new Tank();
    tank.id = auth.userId;
    tank.x = spawn.x;
    tank.y = spawn.y;
    tank.angle = playerIdx === 0 ? 0 : 180;
    tank.alive = true;
    this.state.tanks.set(client.sessionId, tank);
    this.state.lives.set(client.sessionId, LIVES_PER_GAME);

    client.send('maze', { segments: this.wallSegments });

    console.log(`[TankRoom] player joined, playerCount=${this.playerCount}, starting countdown=${this.playerCount === 2}`);
    if (this.playerCount === 2) {
      this.startCountdown();
    }
  }

  private startCountdown(): void {
    if (this.countdownStarted) return;
    this.countdownStarted = true;
    let count = GAME_START_COUNTDOWN_SECONDS;
    this.state.countdown = count;
    console.log(`[TankRoom] startCountdown count=${count}`);

    const interval = this.clock.setInterval(() => {
      count--;
      this.state.countdown = count;
      console.log(`[TankRoom] countdown tick count=${count} phase=${this.state.phase}`);

      if (count <= 0) {
        interval.clear();
        this.state.phase = 'playing';
        console.log(`[TankRoom] phase → playing`);
        this.startGameLoop();
      }
    }, 1000);
  }

  private startGameLoop(): void {
    this.setSimulationInterval((dt) => this.tick(dt / 1000), 1000 / SERVER_TICK_HZ);
  }

  private tick(dt: number): void {
    if (this.state.phase !== 'playing') return;

    // 1. Process pending inputs → move tanks
    this.state.tanks.forEach((tank, sessionId) => {
      if (!tank.alive) return;

      const input = this.pendingInputs.get(sessionId);
      if (!input) return;

      const tankState: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };

      // Handle firing — weapon powerup takes priority over normal bullets
      if (input.fire) {
        let missileEffectIdx = -1;
        for (let i = 0; i < tank.effects.length; i++) {
          const e = tank.effects[i];
          if (e && e.type === PowerupType.TARGETING_MISSILE && e.remainingAmmo > 0) {
            missileEffectIdx = i;
            break;
          }
        }

        if (missileEffectIdx >= 0) {
          // Fire targeting missile — consumes the powerup effect
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
          // Normal bullet
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

      // Resolve effective stats from active powerups (modifier-stack pattern).
      // Physics functions (updateTank, createBullet) are not modified — callers
      // apply resolved numbers before invoking them.
      // See: powerups.ts → resolveStats()
      const effects: ActiveEffectData[] = Array.from({ length: tank.effects.length }, (_, i) => ({
        type: tank.effects[i]!.type,
        remainingTime: tank.effects[i]!.remainingTime,
        remainingAmmo: tank.effects[i]!.remainingAmmo,
      }));
      const _stats = resolveStats(effects);
      // Future: pass TANK_SPEED * _stats.speedMultiplier into updateTank when speed-modifying
      // powerups are added. For now targeting_missile is weapon-only, multiplier is 1.

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

    // 3. Advance missiles (homing + wall avoidance)
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

      if (
        updated.age >= MISSILE_LIFETIME_SECONDS ||
        updated.x < 0 ||
        updated.x > this.mazeWidth ||
        updated.y < 0 ||
        updated.y > this.mazeHeight
      ) {
        missilesToRemove.push(i);
        continue;
      }

      let hitTank = false;
      this.state.tanks.forEach((tank, sessionId) => {
        if (hitTank || !tank.alive) return;
        const ts: TankState = { id: tank.id, x: tank.x, y: tank.y, angle: tank.angle, speed: 0 };
        if (checkCircleTankCollision(updated.x, updated.y, MISSILE_RADIUS, ts)) {
          hitTank = true;
          missilesToRemove.push(i);
          this.onBulletHitTank(sessionId);
        }
      });

      if (!hitTank) {
        missile.x = updated.x;
        missile.y = updated.y;
        missile.vx = updated.vx;
        missile.vy = updated.vy;
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
        // Ignore pickup if tank already holds any powerup
        if (tank.effects.length > 0) return;

        const dx = tank.x - powerup.x;
        const dy = tank.y - powerup.y;
        if (dx * dx + dy * dy <= POWERUP_COLLECTION_RADIUS * POWERUP_COLLECTION_RADIUS) {
          const effect = new ActiveEffect();
          effect.type = powerup.type;
          effect.remainingTime = -1; // weapon powerup — ammo-based, not timed
          effect.remainingAmmo = 1;  // targeting_missile: 1 shot
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

  private spawnPowerup(): void {
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

    // Shuffle candidates and pick the first valid one
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
    // No valid cell found — skip this spawn cycle
  }

  private onBulletHitTank(killedSessionId: string): void {
    const currentLives = this.state.lives.get(killedSessionId);
    if (currentLives === undefined) return;

    const newLives = currentLives - 1;
    this.state.lives.set(killedSessionId, newLives);

    if (newLives <= 0) {
      let winnerSessionId = '';
      const loserSessionId = killedSessionId;

      this.state.lives.forEach((_lives, sid) => {
        if (sid !== killedSessionId) {
          winnerSessionId = sid;
        }
      });

      const winnerId = this.sessionToUserId.get(winnerSessionId) ?? '';
      const loserId = this.sessionToUserId.get(loserSessionId) ?? '';
      void this.onGameEnd(winnerId, loserId);
    } else {
      const tank = this.state.tanks.get(killedSessionId);
      if (tank) {
        tank.alive = false;
        // Clear effects on death
        tank.effects.splice(0, tank.effects.length);

        this.clock.setTimeout(() => {
          if (!this.maze) return;
          const occupied = Array.from(this.state.tanks.values())
            .filter((t) => t.alive)
            .map((t) => ({ x: t.x, y: t.y }));
          const spawn = getRandomSpawn(this.maze, occupied);
          tank.x = spawn.x;
          tank.y = spawn.y;
          tank.angle = 0;
          tank.alive = true;
        }, RESPAWN_DELAY_MS);
      }
    }
  }

  private async onGameEnd(winnerId: string, loserId: string): Promise<void> {
    this.state.phase = 'ended';
    this.state.winnerId = winnerId;

    const game = await prisma.game.findUnique({
      where: { id: this.gameDbId },
      include: { creatorCharity: true, opponentCharity: true },
    });

    if (!game) return;

    const betAmountCents = game.betAmountCents;
    const pledgeFee = Math.round(betAmountCents * PLEDGE_FEE_RATE);
    const netAmountCents = betAmountCents - pledgeFee;

    const winnerCharityId =
      winnerId === game.creatorId ? game.creatorCharityId : game.opponentCharityId;

    if (!winnerCharityId) return;

    const winnerLivesRemaining = (() => {
      let lives = 0;
      this.state.lives.forEach((l, sid) => {
        const uid = this.sessionToUserId.get(sid);
        if (uid === winnerId) lives = l;
      });
      return lives;
    })();

    const startedAt = game.startedAt ?? new Date();
    const endedAt = new Date();
    const durationSeconds = (endedAt.getTime() - startedAt.getTime()) / 1000;

    await prisma.$transaction([
      prisma.game.update({
        where: { id: this.gameDbId },
        data: {
          status: 'COMPLETED',
          winnerId,
          loserId,
          winnerLivesRemaining,
          endedAt,
          durationSeconds,
        },
      }),
      prisma.user.update({
        where: { id: winnerId },
        data: {
          totalDonatedCents: { increment: netAmountCents * 2 },
          reservedBalance: { decrement: betAmountCents },
          activeGameId: null,
        },
      }),
      prisma.user.update({
        where: { id: loserId },
        data: {
          totalDonatedCents: { increment: netAmountCents },
          reservedBalance: { decrement: betAmountCents },
          activeGameId: null,
        },
      }),
      prisma.contribution.create({
        data: {
          userId: winnerId,
          gameId: this.gameDbId,
          charityId: winnerCharityId,
          role: 'WINNER',
          betAmountCents,
          netAmountCents,
        },
      }),
      prisma.contribution.create({
        data: {
          userId: loserId,
          gameId: this.gameDbId,
          charityId: winnerCharityId,
          role: 'LOSER',
          betAmountCents,
          netAmountCents,
        },
      }),
    ]);
  }

  async onLeave(client: Client, _consented: boolean): Promise<void> {
    if (this.state.phase !== 'playing') {
      this.sessionToUserId.delete(client.sessionId);
      this.state.tanks.delete(client.sessionId);
      this.state.lives.delete(client.sessionId);
      this.pendingInputs.delete(client.sessionId);
      this.playerCount--;
      return;
    }

    try {
      await this.allowReconnection(client, GRACE_PERIOD_SECONDS);
    } catch {
      const loserSessionId = client.sessionId;
      let winnerSessionId = '';

      this.state.tanks.forEach((_tank, sid) => {
        if (sid !== loserSessionId) {
          winnerSessionId = sid;
        }
      });

      const winnerId = this.sessionToUserId.get(winnerSessionId) ?? '';
      const loserId = this.sessionToUserId.get(loserSessionId) ?? '';

      if (winnerId && loserId) {
        await this.onGameEnd(winnerId, loserId);
      }
    }
  }
}
