import type { Client } from '@colyseus/core';
import { RESPAWN_DELAY_MS } from '@tankbet/game-engine/constants';
import { getRandomSpawn } from '@tankbet/game-engine/maze';
import { BaseTankRoom } from './BaseTankRoom';

export class PracticeRoom extends BaseTankRoom {
  maxClients = 1;

  onCreate(): void {
    this.autoDispose = true;
    this.initRoom();
  }

  onJoin(client: Client, _options: unknown, auth?: { userId: string }): void {
    const userId = auth?.userId ?? `practice-${client.sessionId}`;
    this.spawnPlayer(client, userId);
    this.state.phase = 'playing';
    this.startGameLoop();
  }

  // When hit: brief invincibility window then respawn. No lives tracking, game never ends.
  protected onBulletHitTank(killedSessionId: string): void {
    const tank = this.state.tanks.get(killedSessionId);
    if (!tank || !tank.alive) return;

    tank.alive = false;
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

  onLeave(_client: Client): void {
    // Single player — nothing to do; autoDispose handles cleanup.
  }
}
