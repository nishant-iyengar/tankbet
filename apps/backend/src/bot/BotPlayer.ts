/**
 * Bot player controller for practice mode.
 *
 * Every 3 ticks (~20Hz decision rate), builds a 147-dim observation from the
 * current game state, runs the PPO actor forward pass, and returns an InputState.
 */
import type { InputState, BulletState, WallSegment } from '@tankbet/game-engine/physics';
import {
  BULLET_FIRE_COOLDOWN_MS,
  SERVER_TICK_HZ,
  MAX_BULLETS_PER_TANK,
  BOT_DECISION_HZ,
} from '@tankbet/game-engine/constants';
import type { Maze } from '@tankbet/game-engine/maze';
import { buildObservation, buildWallLookup, type BotTankState } from './observation';
import { forward } from './inference';
import { decodeAction } from './action-table';

const DECISION_INTERVAL = Math.round(SERVER_TICK_HZ / BOT_DECISION_HZ);
const FIRE_COOLDOWN_TICKS = Math.round((BULLET_FIRE_COOLDOWN_MS / 1000) * SERVER_TICK_HZ);

// Practice mode episode length for tick ratio normalization (matches training Phase 1+)
const MAX_EPISODE_TICKS = 120 * SERVER_TICK_HZ;

export class BotPlayer {
  readonly sessionId: string;
  private tickCounter = 0;
  private wallLookup: ReturnType<typeof buildWallLookup>;
  private lastFiredTick = 0;
  private shotsFired = 0;

  constructor(sessionId: string, maze: Maze) {
    this.sessionId = sessionId;
    this.wallLookup = buildWallLookup(maze);
  }

  /** Call when a new maze is generated (e.g., "New Maze" button). */
  updateMaze(maze: Maze): void {
    this.wallLookup = buildWallLookup(maze);
    this.lastFiredTick = 0;
    this.tickCounter = 0;
    this.shotsFired = 0;
  }

  /** Reset tick counter on respawn so tick ratio stays meaningful. */
  onRespawn(): void {
    this.tickCounter = 0;
    this.lastFiredTick = 0;
    this.shotsFired = 0;
  }

  /** Called every physics tick. Returns an InputState every DECISION_INTERVAL ticks, or null otherwise. */
  tick(
    botTank: BotTankState,
    humanTank: BotTankState,
    bullets: BulletState[],
    segments: WallSegment[],
  ): InputState | null {
    this.tickCounter++;
    if (this.tickCounter % DECISION_INTERVAL !== 0) return null;
    if (!botTank.alive) return null;

    // Check if bot can fire
    const ticksSinceLastFired = this.tickCounter - this.lastFiredTick;
    let bulletCount = 0;
    for (const b of bullets) {
      if (b.ownerId === botTank.sessionId) bulletCount++;
    }
    const canFire = ticksSinceLastFired >= FIRE_COOLDOWN_TICKS && bulletCount < MAX_BULLETS_PER_TANK;

    // Tick ratio: normalized episode progress (0→1) matching training
    const tickRatio = Math.min(this.tickCounter / MAX_EPISODE_TICKS, 1);

    // Ammo fraction: unlimited in practice mode (matches training max_ammo_per_life=999)
    const ammoFraction = 1;

    const obs = buildObservation(
      botTank,
      humanTank,
      bullets,
      segments,
      this.wallLookup,
      ticksSinceLastFired,
      canFire,
      tickRatio,
      ammoFraction,
    );

    const actionIdx = forward(obs);
    const input = decodeAction(actionIdx);

    // Track firing for cooldown observation
    if (input.fire && canFire) {
      this.lastFiredTick = this.tickCounter;
      this.shotsFired++;
    }

    return input;
  }
}
