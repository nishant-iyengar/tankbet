// Re-export schema classes from the shared game-engine package.
// This ensures the server and client use the SAME schema definitions.
export {
  Tank,
  TankRoomState,
} from '@tankbet/game-engine/schema';
export type { GamePhase } from '@tankbet/game-engine/schema';
