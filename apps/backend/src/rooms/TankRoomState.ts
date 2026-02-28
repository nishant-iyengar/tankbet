import { Schema, type, MapSchema, ArraySchema } from '@colyseus/schema';
import { GAME_START_COUNTDOWN_SECONDS } from '@tankbet/game-engine/constants';

export class ActiveEffect extends Schema {
  @type('string') type: string = '';          // PowerupType value
  @type('float32') remainingTime: number = -1; // seconds remaining; -1 if ammo-based
  @type('int8') remainingAmmo: number = -1;    // shots remaining; -1 if timed
}

export class Bullet extends Schema {
  @type('string') id: string = '';
  @type('string') ownerId: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') vx: number = 0;
  @type('float32') vy: number = 0;
  // age is server-private (only used for expiry); not synced to clients
}

export class Powerup extends Schema {
  @type('string') id: string = '';
  @type('string') type: string = '';  // PowerupType value
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
}

export class Missile extends Schema {
  @type('string') id: string = '';
  @type('string') ownerId: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') vx: number = 0;
  @type('float32') vy: number = 0;
  @type('float32') age: number = 0;
  // initialTargetId is server-private (only used by updateMissile); not synced to clients
}

export class Tank extends Schema {
  @type('string') id: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') angle: number = 0;
  @type('boolean') alive: boolean = true;
  @type([ActiveEffect]) effects = new ArraySchema<ActiveEffect>();
}

export type GamePhase = 'countdown' | 'playing' | 'ended';

export class TankRoomState extends Schema {
  @type({ map: Tank }) tanks = new MapSchema<Tank>();
  @type([Bullet]) bullets = new ArraySchema<Bullet>();
  @type([Powerup]) powerups = new ArraySchema<Powerup>();
  @type([Missile]) missiles = new ArraySchema<Missile>();
  @type('int8') countdown: number = GAME_START_COUNTDOWN_SECONDS;
  @type('string') phase: GamePhase = 'countdown';
  @type('string') winnerId: string = '';
  @type({ map: 'int8' }) lives = new MapSchema<number>();
}
