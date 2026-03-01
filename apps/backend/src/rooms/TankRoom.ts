import { ServerError, Deferred } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import {
  GAME_START_COUNTDOWN_SECONDS,
  GRACE_PERIOD_SECONDS,
  LIVES_PER_GAME,
  TIE_WINDOW_MS,
  BATTLE_TRANSITION_DELAY_MS,
  PLEDGE_FEE_RATE,
} from '@tankbet/game-engine/constants';
import { BaseTankRoom } from './BaseTankRoom';
import { prisma } from '../prisma';
import { isBeta } from '../environment';

export class TankRoom extends BaseTankRoom {
  maxClients = 2;
  gameDbId = '';
  private allowedUserIds: string[] = [];
  private countdownStarted = false;
  private firstDeathSessionId: string | null = null;
  private tieWindowHandle: { clear(): void } | null = null;
  private pendingReconnects = new Map<string, Deferred<Client>>();

  onCreate(options: { gameId: string; player1Id: string; player2Id: string }): void {
    this.autoDispose = false;
    this.gameDbId = options.gameId;
    this.allowedUserIds = [options.player1Id, options.player2Id];
    this.setPrivate(true);
    this.lock();
    this.initRoom();

    this.onMessage('forfeit', (client: Client) => {
      const loserUserId = this.sessionToUserId.get(client.sessionId) ?? '';
      let winnerUserId = '';
      this.sessionToUserId.forEach((uid, sid) => {
        if (sid !== client.sessionId) winnerUserId = uid;
      });
      if (loserUserId && winnerUserId) {
        void this.onGameEnd(winnerUserId, loserUserId);
      }
      client.leave();
    });
  }

  onJoin(client: Client, _options: unknown, auth?: { userId: string }): void {
    if (!auth || !this.allowedUserIds.includes(auth.userId)) {
      throw new ServerError(403, 'Not a participant in this game');
    }

    console.log(`[TankRoom] onJoin sessionId=${client.sessionId} userId=${auth.userId}`);

    // Cancel any pending grace-period reconnection for this user (they rejoined with a new session)
    const pending = this.pendingReconnects.get(auth.userId);
    if (pending) {
      this.pendingReconnects.delete(auth.userId);
      pending.reject(new Error('reconnected with new session'));
    }

    // Check if this user already has a tank mapped to an old session (mid-game rejoin)
    let existingSessionId: string | null = null;
    this.sessionToUserId.forEach((uid, sid) => {
      if (uid === auth.userId) existingSessionId = sid;
    });

    if (existingSessionId !== null) {
      // Remap the existing tank/state to the new session
      const tank = this.state.tanks.get(existingSessionId);
      const lives = this.state.lives.get(existingSessionId);
      const playerIdx = this.sessionToPlayerIdx.get(existingSessionId);

      this.sessionToUserId.delete(existingSessionId);
      this.sessionToPlayerIdx.delete(existingSessionId);
      this.state.tanks.delete(existingSessionId);
      this.state.lives.delete(existingSessionId);
      this.pendingInputs.delete(existingSessionId);

      this.sessionToUserId.set(client.sessionId, auth.userId);
      if (playerIdx !== undefined) this.sessionToPlayerIdx.set(client.sessionId, playerIdx);
      if (tank !== undefined) this.state.tanks.set(client.sessionId, tank);
      if (lives !== undefined) this.state.lives.set(client.sessionId, lives);

      // Re-send maze so the reconnected client can render
      client.send('maze', { segments: this.wallSegments });
      console.log(`[TankRoom] remapped existing player session=${existingSessionId} → ${client.sessionId}`);
    } else {
      this.spawnPlayer(client, auth.userId);
      console.log(`[TankRoom] player spawned, playerCount=${this.playerCount}`);
      if (this.playerCount === 2) {
        this.startCountdown();
      }
    }
  }

  private startCountdown(): void {
    if (this.countdownStarted) return;
    this.countdownStarted = true;
    let count = GAME_START_COUNTDOWN_SECONDS;
    this.state.countdown = count;
    this.state.phase = 'countdown';
    console.log(`[TankRoom] startCountdown count=${count}`);

    const interval = this.clock.setInterval(() => {
      count--;
      this.state.countdown = count;
      console.log(`[TankRoom] countdown tick count=${count}`);

      if (count <= 0) {
        interval.clear();
        this.state.phase = 'playing';
        console.log(`[TankRoom] phase → playing`);
        this.startGameLoop();
      }
    }, 1000);
  }

  protected onBulletHitTank(killedSessionId: string): void {
    const tank = this.state.tanks.get(killedSessionId);
    if (!tank || !tank.alive) return;

    // Mark tank as dead immediately
    tank.alive = false;
    tank.effects.splice(0, tank.effects.length);

    if (this.firstDeathSessionId === null) {
      // First death in this battle — start the tie window
      this.firstDeathSessionId = killedSessionId;
      this.tieWindowHandle = this.clock.setTimeout(() => {
        // Tie window expired with no second death → decisive result
        this.tieWindowHandle = null;
        this.resolveBattle(killedSessionId);
      }, TIE_WINDOW_MS);
    } else {
      // Second death within the tie window → tie
      this.tieWindowHandle?.clear();
      this.tieWindowHandle = null;
      this.firstDeathSessionId = null;
      this.state.roundWinnerId = '';
      this.state.phase = 'resolving';
      this.clock.setTimeout(() => {
        this.startNewBattle();
      }, BATTLE_TRANSITION_DELAY_MS);
    }
  }

  private resolveBattle(loserSessionId: string): void {
    let winnerSessionId = '';
    this.state.tanks.forEach((_tank, sid) => {
      if (sid !== loserSessionId) winnerSessionId = sid;
    });

    const winnerId = this.sessionToUserId.get(winnerSessionId) ?? '';
    const loserId = this.sessionToUserId.get(loserSessionId) ?? '';

    const currentLives = this.state.lives.get(loserSessionId) ?? 0;
    const newLives = currentLives - 1;
    this.state.lives.set(loserSessionId, newLives);

    console.log(`[TankRoom] battle resolved: winner=${winnerId} loser=${loserId} loserLivesLeft=${newLives}`);

    if (newLives <= 0) {
      // Game over
      this.state.roundWinnerId = winnerId;
      void this.onGameEnd(winnerId, loserId);
    } else {
      // Start new battle after transition delay
      this.state.roundWinnerId = winnerId;
      this.state.phase = 'resolving';
      this.firstDeathSessionId = null;
      this.clock.setTimeout(() => {
        this.startNewBattle();
      }, BATTLE_TRANSITION_DELAY_MS);
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

    if (isBeta) {
      // In beta, just update game status and clear active game IDs
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
          data: { activeGameId: null },
        }),
        prisma.user.update({
          where: { id: loserId },
          data: { activeGameId: null },
        }),
      ]);
      return;
    }

    const betAmountCents = game.betAmountCents;
    const pledgeFee = Math.round(betAmountCents * PLEDGE_FEE_RATE);
    const netAmountCents = betAmountCents - pledgeFee;

    const winnerCharityId =
      winnerId === game.creatorId ? game.creatorCharityId : game.opponentCharityId;

    if (!winnerCharityId) return;

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

  async onLeave(client: Client, _code: number): Promise<void> {
    if (this.state.phase !== 'playing') {
      this.sessionToUserId.delete(client.sessionId);
      this.state.tanks.delete(client.sessionId);
      this.state.lives.delete(client.sessionId);
      this.pendingInputs.delete(client.sessionId);
      this.playerCount--;
      return;
    }

    const userId = this.sessionToUserId.get(client.sessionId) ?? '';
    const loserSessionId = client.sessionId;

    try {
      const deferred = this.allowReconnection(client, GRACE_PERIOD_SECONDS);
      if (userId) this.pendingReconnects.set(userId, deferred);
      await deferred;
      // Reconnected via same session — clean up tracking
      if (userId) this.pendingReconnects.delete(userId);
    } catch {
      if (userId) this.pendingReconnects.delete(userId);
      // Only forfeit if this session is still the active mapping (not remapped by a new-session rejoin)
      const currentLoserId = this.sessionToUserId.get(loserSessionId) ?? '';
      if (!currentLoserId) return;

      let winnerSessionId = '';
      this.state.tanks.forEach((_tank, sid) => {
        if (sid !== loserSessionId) winnerSessionId = sid;
      });

      const winnerId = this.sessionToUserId.get(winnerSessionId) ?? '';
      const loserId = currentLoserId;

      if (winnerId && loserId) {
        await this.onGameEnd(winnerId, loserId);
      }
    }
  }
}
