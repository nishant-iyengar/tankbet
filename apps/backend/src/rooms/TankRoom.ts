import { ServerError } from '@colyseus/core';
import type { Client } from '@colyseus/core';
import {
  GAME_START_COUNTDOWN_SECONDS,
  GRACE_PERIOD_SECONDS,
  TIE_WINDOW_MS,
  BATTLE_TRANSITION_DELAY_MS,
  GAME_END_DISCONNECT_DELAY_MS,
} from '@tankbet/game-engine/constants';
import { BaseTankRoom } from './BaseTankRoom';
import { prisma } from '../prisma';
import { logger } from '../logger';

export class TankRoom extends BaseTankRoom {
  maxClients = 2;
  gameDbId = '';
  private allowedUserIds: string[] = [];
  private countdownStarted = false;
  private firstDeathSessionId: string | null = null;
  private tieWindowHandle: { clear(): void } | null = null;

  /** Return the session ID of the other player (the one that isn't `sessionId`). */
  private getOpponentSessionId(sessionId: string): string {
    for (const [sid] of this.state.tanks) {
      if (sid !== sessionId) return sid;
    }
    return '';
  }

  onCreate(options: { gameId: string; player1Id: string; player2Id: string; lives?: number }): void {
    this.autoDispose = false;
    this.gameDbId = options.gameId;
    this.allowedUserIds = [options.player1Id, options.player2Id];
    if (options.lives !== undefined) this.livesPerGame = options.lives;
    this.setPrivate(true);
    this.initRoom();

    // Client sends this after reconnecting once message handlers are registered
    this.onMessage('request:state', (client: Client) => {
      client.send('maze', { segments: this.wallSegments });
      if (this.bullets.length > 0) {
        client.send('bullet:sync', this.bullets);
      }
    });

    this.onMessage('forfeit', (client: Client) => {
      const loserUserId = this.sessionToUserId.get(client.sessionId) ?? '';
      const winnerUserId = this.sessionToUserId.get(this.getOpponentSessionId(client.sessionId)) ?? '';
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

    logger.info({ sessionId: client.sessionId, userId: auth.userId }, 'onJoin');

    // Check if this user already has state from a previous session (safety net
    // for cases where the reconnection token expired but the game hasn't
    // forfeited yet). Remap the old session to the new one.
    let existingSessionId: string | null = null;
    this.sessionToUserId.forEach((uid, sid) => {
      if (uid === auth.userId) existingSessionId = sid;
    });

    if (existingSessionId !== null) {
      const tank = this.state.tanks.get(existingSessionId);
      const lives = this.state.lives.get(existingSessionId);
      const playerIdx = this.sessionToPlayerIdx.get(existingSessionId);

      this.sessionToUserId.delete(existingSessionId);
      this.sessionToPlayerIdx.delete(existingSessionId);
      this.state.tanks.delete(existingSessionId);
      this.state.lives.delete(existingSessionId);
      this.pendingInputs.delete(existingSessionId);
      // Remap lag compensation state
      const oldHistory = this.positionHistory.get(existingSessionId);
      this.positionHistory.delete(existingSessionId);
      if (oldHistory) this.positionHistory.set(client.sessionId, oldHistory);
      const oldRtt = this.clientRtt.get(existingSessionId);
      this.clientRtt.delete(existingSessionId);
      if (oldRtt !== undefined) this.clientRtt.set(client.sessionId, oldRtt);

      this.sessionToUserId.set(client.sessionId, auth.userId);
      this.userIdToSession.set(auth.userId, client.sessionId);
      if (playerIdx !== undefined) this.sessionToPlayerIdx.set(client.sessionId, playerIdx);
      if (tank !== undefined) this.state.tanks.set(client.sessionId, tank);
      if (lives !== undefined) this.state.lives.set(client.sessionId, lives);

      client.send('maze', { segments: this.wallSegments });
      if (this.bullets.length > 0) {
        client.send('bullet:sync', this.bullets);
      }
      logger.info({ oldSessionId: existingSessionId, newSessionId: client.sessionId }, 'remapped existing player session');
    } else {
      this.spawnPlayer(client, auth.userId);
      logger.info({ playerCount: this.playerCount }, 'player spawned');
      if (this.playerCount === 2) {
        this.startCountdown();
      }
    }
  }

  onDrop(client: Client): void {
    const activePhases = ['playing', 'countdown', 'resolving'];
    if (!activePhases.includes(this.state.phase)) {
      // Not in an active game phase — just clean up like a normal leave
      this.sessionToUserId.delete(client.sessionId);
      this.state.tanks.delete(client.sessionId);
      this.state.lives.delete(client.sessionId);
      this.pendingInputs.delete(client.sessionId);
      this.positionHistory.delete(client.sessionId);
      this.clientRtt.delete(client.sessionId);
      this.playerCount--;
      return;
    }

    const userId = this.sessionToUserId.get(client.sessionId) ?? '';
    if (!userId) return;

    this.pendingInputs.delete(client.sessionId);
    logger.info({ userId, sessionId: client.sessionId }, 'player dropped — allowing reconnection');

    // Hold the seat for the grace period. If the player reconnects within
    // this window, Colyseus fires onReconnect and reuses the same sessionId.
    // If the timeout expires, the promise rejects and we forfeit.
    const deferred = this.allowReconnection(client, GRACE_PERIOD_SECONDS);
    deferred.then(() => {
      // Reconnection succeeded — handled in onReconnect
      logger.info({ userId, sessionId: client.sessionId }, 'allowReconnection resolved — player reconnected');
    }).catch(() => {
      // Timeout expired — forfeit the game
      const loserSessionId = client.sessionId;
      const loserId = this.sessionToUserId.get(loserSessionId) ?? '';
      if (!loserId) return;

      const winnerId = this.sessionToUserId.get(this.getOpponentSessionId(loserSessionId)) ?? '';
      if (winnerId && loserId) {
        logger.info({ winnerId, loserId }, 'grace period expired — forfeiting');
        void this.onGameEnd(winnerId, loserId);
      }
    });
  }

  onReconnect(client: Client): void {
    const userId = this.sessionToUserId.get(client.sessionId) ?? '';
    logger.info({ userId, sessionId: client.sessionId }, 'player reconnected');

    // Don't send maze/bullets here — the client hasn't registered message
    // handlers yet (setupRoom runs after the reconnect promise resolves).
    // Instead, the client sends 'request:state' once handlers are ready.
  }

  onLeave(client: Client): void {
    // onLeave fires only for consented/intentional leaves (e.g. forfeit, leaving waiting room).
    // During active games, unexpected disconnects go through onDrop instead.
    this.sessionToUserId.delete(client.sessionId);
    this.state.tanks.delete(client.sessionId);
    this.state.lives.delete(client.sessionId);
    this.pendingInputs.delete(client.sessionId);
    this.positionHistory.delete(client.sessionId);
    this.clientRtt.delete(client.sessionId);
    this.playerCount--;
  }

  private startCountdown(): void {
    if (this.countdownStarted) return;
    this.countdownStarted = true;
    let count = GAME_START_COUNTDOWN_SECONDS;
    this.state.countdown = count;
    this.state.phase = 'countdown';
    logger.info({ count }, 'startCountdown');

    const interval = this.clock.setInterval(() => {
      count--;
      this.state.countdown = count;
      logger.info({ count }, 'countdown tick');

      if (count <= 0) {
        interval.clear();
        this.state.phase = 'playing';
        logger.info('phase → playing');
        this.startGameLoop();
      }
    }, 1000);
  }

  protected onBulletHitTank(killedSessionId: string): void {
    const tank = this.state.tanks.get(killedSessionId);
    if (!tank || !tank.alive) return;

    tank.alive = false;

    if (this.firstDeathSessionId === null) {
      this.firstDeathSessionId = killedSessionId;
      this.tieWindowHandle = this.clock.setTimeout(() => {
        this.tieWindowHandle = null;
        this.resolveBattle(killedSessionId);
      }, TIE_WINDOW_MS);
    } else {
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
    const winnerSessionId = this.getOpponentSessionId(loserSessionId);
    const winnerId = this.sessionToUserId.get(winnerSessionId) ?? '';
    const loserId = this.sessionToUserId.get(loserSessionId) ?? '';

    const currentLives = this.state.lives.get(loserSessionId) ?? 0;
    const newLives = currentLives - 1;
    this.state.lives.set(loserSessionId, newLives);

    logger.info({ winnerId, loserId, loserLivesLeft: newLives }, 'battle resolved');

    if (newLives <= 0) {
      this.state.roundWinnerId = winnerId;
      void this.onGameEnd(winnerId, loserId);
    } else {
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
    this.broadcastPatch();

    const game = await prisma.game.findUnique({
      where: { id: this.gameDbId },
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

    this.clock.setTimeout(() => { this.disconnect(); }, GAME_END_DISCONNECT_DELAY_MS);
  }
}
