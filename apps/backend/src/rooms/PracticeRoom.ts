import type { Client } from '@colyseus/core';
import { RESPAWN_DELAY_MS } from '@tankbet/game-engine/constants';
// import { BotPlayer } from '../bot/BotPlayer';
// import type { BotTankState } from '../bot/observation';
import { BaseTankRoom } from './BaseTankRoom';

// const BOT_SESSION_ID = '__bot__';
// const BOT_USER_ID = 'bot-opponent';

export class PracticeRoom extends BaseTankRoom {
  maxClients = 1;

  // private botPlayer: BotPlayer | null = null;
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

    this.spawnPlayer(client, userId);
    // this.spawnBot(BOT_SESSION_ID, BOT_USER_ID);
    // this.botPlayer = new BotPlayer(BOT_USER_ID, this.maze!);

    this.state.phase = 'playing';
    this.startGameLoop();
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
