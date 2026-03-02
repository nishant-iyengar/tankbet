import { schema, MapSchema, ArraySchema } from '@colyseus/schema';
import { GAME_START_COUNTDOWN_SECONDS } from './constants.js';

export const ActiveEffect = schema({
  type:          { type: 'string',  default: '' },   // PowerupType value
  remainingTime: { type: 'float32', default: -1 },   // seconds remaining; -1 if ammo-based
  remainingAmmo: { type: 'int8',    default: -1 },   // shots remaining; -1 if timed
}, 'ActiveEffect');
export interface ActiveEffect {
  type: string;
  remainingTime: number;
  remainingAmmo: number;
}

export const Powerup = schema({
  id:   { type: 'string',  default: '' },
  type: { type: 'string',  default: '' }, // PowerupType value
  x:    { type: 'float32', default: 0 },
  y:    { type: 'float32', default: 0 },
}, 'Powerup');
export interface Powerup {
  id: string;
  type: string;
  x: number;
  y: number;
}

export const Tank = schema({
  id:         { type: 'string',  default: '' },
  x:          { type: 'float32', default: 0 },
  y:          { type: 'float32', default: 0 },
  angle:      { type: 'float32', default: 0 },
  alive:      { type: 'boolean', default: true },
  speed:      { type: 'float32', default: 0 },
  lastAckSeq: { type: 'uint16',  default: 0 },
  effects:    [ActiveEffect],
}, 'Tank');
export interface Tank {
  id: string;
  x: number;
  y: number;
  angle: number;
  alive: boolean;
  speed: number;
  lastAckSeq: number;
  effects: ArraySchema<ActiveEffect>;
}

export type GamePhase = 'waiting' | 'countdown' | 'playing' | 'resolving' | 'ended';

export const TankRoomState = schema({
  tanks:         { map: Tank },
  powerups:      [Powerup],
  countdown:     { type: 'int8',   default: GAME_START_COUNTDOWN_SECONDS },
  phase:         { type: 'string', default: 'waiting' },
  winnerId:      { type: 'string', default: '' },
  roundWinnerId: { type: 'string', default: '' }, // userId of round winner, '' = tie
  lives:         { map: 'int8' },
  serverTick:    { type: 'uint32', default: 0 },
}, 'TankRoomState');
export interface TankRoomState {
  tanks:         MapSchema<Tank>;
  powerups:      ArraySchema<Powerup>;
  countdown:     number;
  phase:         string;
  winnerId:      string;
  roundWinnerId: string;
  lives:         MapSchema<number>;
  serverTick:    number;
}
