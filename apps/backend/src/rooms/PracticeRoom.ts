import type { Client } from '@colyseus/core';
import { RESPAWN_DELAY_MS } from '@tankbet/game-engine/constants';
import { BotPlayer } from '../bot/BotPlayer';
import type { BotTankState } from '../bot/observation';
import { BaseTankRoom } from './BaseTankRoom';

const BOT_SESSION_ID = '__bot__';
const BOT_USER_ID = 'bot-opponent';

export class PracticeRoom extends BaseTankRoom {
  maxClients = 1;

  private botPlayer: BotPlayer | null = null;
  private humanSessionId: string | null = null;

  onCreate(): void {
    this.autoDispose = true;
    this.initRoom();

    // Toggle pause in practice mode
    this.onMessage('pause', () => {
      if (this.state.phase === 'playing') {
        this.state.phase = 'paused';
      } else if (this.state.phase === 'paused') {
        this.state.phase = 'playing';
      }
    });
  }

  onJoin(client: Client, _options: unknown, auth?: { userId: string }): void {
    const userId = auth?.userId ?? `practice-${client.sessionId}`;
    this.humanSessionId = client.sessionId;

    // Spawn human player first (index 0), then bot (index 1)
    this.spawnPlayer(client, userId);
    this.spawnBot(BOT_SESSION_ID, BOT_USER_ID);

    // Create bot controller
    if (this.maze) {
      this.botPlayer = new BotPlayer(BOT_USER_ID, this.maze);
    }

    this.state.phase = 'playing';
    this.startGameLoop();
  }

  /** New round: new maze, clear bullets, respawn tanks, reset bot state. */
  protected override startNewBattle(): void {
    super.startNewBattle();
    if (this.maze && this.botPlayer) {
      this.botPlayer.updateMaze(this.maze);
    }
    // Re-initialize bot position history (super.startNewBattle() clears it)
    const botTank = this.state.tanks.get(BOT_SESSION_ID);
    if (botTank) {
      this.positionHistory.set(BOT_SESSION_ID, [{
        tick: 0, time: 0, x: botTank.x, y: botTank.y, angle: botTank.angle,
      }]);
    }
  }

  /** Inject bot inputs before each physics tick. */
  protected override onBeforeTick(): void {
    if (!this.botPlayer) return;

    const botTank = this.state.tanks.get(BOT_SESSION_ID);
    if (!botTank) return;

    // Find the human tank
    let humanTank = this.humanSessionId ? this.state.tanks.get(this.humanSessionId) : undefined;
    if (!humanTank) {
      // Fallback: find any tank that isn't the bot
      this.state.tanks.forEach((tank, sessionId) => {
        if (sessionId !== BOT_SESSION_ID) humanTank = tank;
      });
    }
    if (!humanTank) return;

    const botState: BotTankState = {
      x: botTank.x,
      y: botTank.y,
      angle: botTank.angle,
      speed: botTank.speed,
      alive: botTank.alive,
      sessionId: BOT_USER_ID,
    };

    const humanState: BotTankState = {
      x: humanTank.x,
      y: humanTank.y,
      angle: humanTank.angle,
      speed: humanTank.speed,
      alive: humanTank.alive,
      sessionId: this.sessionToUserId.get(this.humanSessionId ?? '') ?? '',
    };

    const input = this.botPlayer.tick(
      botState,
      humanState,
      this.bullets,
      this.wallSegments,
    );

    if (input) {
      this.pendingInputs.set(BOT_SESSION_ID, { keys: input });
    }
  }

  // When hit: brief death then load new map with fresh spawns.
  protected onBulletHitTank(killedSessionId: string): void {
    const tank = this.state.tanks.get(killedSessionId);
    if (!tank || !tank.alive) return;

    tank.alive = false;

    // After a brief delay, start a new round: new maze, clear bullets, respawn both tanks.
    this.clock.setTimeout(() => {
      this.startNewBattle();
    }, RESPAWN_DELAY_MS);
  }

  onLeave(_client: Client): void {
    // Single player — nothing to do; autoDispose handles cleanup.
  }
}
