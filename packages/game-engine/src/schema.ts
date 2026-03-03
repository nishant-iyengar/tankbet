import { schema, MapSchema } from '@colyseus/schema';
import { GAME_START_COUNTDOWN_SECONDS } from './constants.js';

export const Tank = schema({
  id:         { type: 'string',  default: '' },
  x:          { type: 'float32', default: 0 },
  y:          { type: 'float32', default: 0 },
  angle:      { type: 'float32', default: 0 },
  alive:      { type: 'boolean', default: true },
  speed:      { type: 'float32', default: 0 },
}, 'Tank');
export interface Tank {
  id: string;
  x: number;
  y: number;
  angle: number;
  alive: boolean;
  speed: number;
}

export type GamePhase = 'waiting' | 'countdown' | 'playing' | 'resolving' | 'ended';

export const TankRoomState = schema({
  tanks:         { map: Tank },
  countdown:     { type: 'int8',   default: GAME_START_COUNTDOWN_SECONDS },
  phase:         { type: 'string', default: 'waiting' },
  winnerId:      { type: 'string', default: '' },
  roundWinnerId: { type: 'string', default: '' }, // userId of round winner, '' = tie
  lives:         { map: 'int8' },
}, 'TankRoomState');
export interface TankRoomState {
  tanks:         MapSchema<Tank>;
  countdown:     number;
  phase:         string;
  winnerId:      string;
  roundWinnerId: string;
  lives:         MapSchema<number>;
}
