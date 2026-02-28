// Physics
export const CELL_SIZE = 64;
export const TANK_WIDTH = 20;
export const TANK_HEIGHT = 20;
export const BARREL_LENGTH = 18;
export const TANK_COLLISION_RADIUS = 10; // kept for reference; physics uses OBB+barrel dynamically
export const TANK_SPEED = 128;            // px/s  (15% slower than original 150)
export const WALL_FRICTION = 1.0;          // fraction of slide speed removed when touching a wall (was 0.55)
export const CORNER_SHIELD_PADDING = 4;   // extra px beyond OBB to keep tank away from wall endpoints
export const TANK_ROTATION_SPEED = 135;   // deg/s
export const BULLET_SPEED = 184;          // px/s  (50% slower than 368)
export const MAX_BULLETS_PER_TANK = 5;
export const BULLET_LIFETIME_SECONDS = 5; // time-based; bounces are infinite
export const BULLET_RADIUS = 3;
export const BARREL_WIDTH = 5;            // px — barrel rectangle height in renderer
export const WALL_LINE_WIDTH = 2;         // px — wall stroke width in renderer
export const COUNTDOWN_OVERLAY_ALPHA = 0.6; // opacity of countdown overlay
export const HUD_PADDING = 10;            // px — HUD text inset from canvas edge
export const TANK_COLOR_P1 = '#4ade80';   // green — player 1 tank color
export const TANK_COLOR_P2 = '#f87171';   // red   — player 2 tank color
export const MAZE_COLS = 13;
export const MAZE_ROWS = 9;

// Rules
export const GRACE_PERIOD_SECONDS = 30;
export const GAME_START_COUNTDOWN_SECONDS = 3;
export const INVITE_EXPIRY_SECONDS = 120;         // 2 minutes
export const RESPAWN_DELAY_MS = 1500;     // ms — delay before respawn after death
export const BET_AMOUNTS_CENTS = [100, 200, 500] as const;
export type BetAmountCents = (typeof BET_AMOUNTS_CENTS)[number];
export const MIN_DEPOSIT_CENTS = 100;
export const WITHDRAWAL_FEE_CENTS = 25;
export const PLEDGE_FEE_RATE = 0.05;

// Server
export const LIVES_PER_GAME = 5;
export const SERVER_TICK_HZ = 20;
export const CLIENT_FPS = 60;
export const INTERPOLATION_DELAY_MS = 100;

// Powerups
export const PowerupType = {
  TARGETING_MISSILE: 'targeting_missile',
} as const;
export type PowerupType = (typeof PowerupType)[keyof typeof PowerupType];

export const POWERUP_SPAWN_INTERVAL_MIN_S = 8;
export const POWERUP_SPAWN_INTERVAL_MAX_S = 15;
export const POWERUP_MAX_ON_FIELD = 2;
export const POWERUP_COLLECTION_RADIUS = 22; // px — proximity to auto-collect

// Targeting missile
export const MISSILE_SPEED = 92;           // px/s — 50% of BULLET_SPEED (184)
export const MISSILE_RADIUS = 5;           // px — larger than bullet (3 px)
export const MISSILE_HOMING_DELAY_S = 3;   // seconds before switching to closest-tank homing
export const MISSILE_TURN_SPEED_DEG = 200; // deg/s — max steering rate
export const MISSILE_WALL_LOOKAHEAD = 24;  // px — how far ahead to detect walls
export const MISSILE_LIFETIME_SECONDS = 12;
export const MISSILE_COLOR = '#f97316';    // orange
