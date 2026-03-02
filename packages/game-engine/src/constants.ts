// Physics
export const CELL_SIZE = 120;
export const TANK_WIDTH = 20;
export const TANK_HEIGHT = 20;
export const BARREL_LENGTH = 18;
export const TANK_COLLISION_RADIUS = 10; // kept for reference; physics uses OBB+barrel dynamically
export const TANK_SPEED = 128;            // px/s  (15% slower than original 150)
export const WALL_FRICTION = 1.0;          // fraction of slide speed removed when touching a wall (was 0.55)
export const CORNER_SHIELD_PADDING = 4;   // extra px beyond OBB to keep tank away from wall endpoints
export const TANK_ROTATION_SPEED = 135;   // deg/s
export const BULLET_SPEED = 184;          // px/s  (50% slower than 368)
export const MAX_BULLETS_PER_TANK = 10;
export const BULLET_LIFETIME_SECONDS = 7; // time-based; bounces are infinite
export const BULLET_RADIUS = 3;
export const BARREL_WIDTH = 5;            // px — barrel rectangle height in renderer
export const WALL_LINE_WIDTH = 2;         // px — wall stroke width in renderer
export const MAZE_MIN_WALL_FRACTION = 0.15; // minimum wall length as fraction of canvas width
export const COUNTDOWN_OVERLAY_ALPHA = 0.6; // opacity of countdown overlay
export const HUD_PADDING = 10;            // px — HUD text inset from canvas edge
export const TANK_COLOR_P1 = '#4ade80';   // green — player 1 tank color
export const TANK_COLOR_P2 = '#f87171';   // red   — player 2 tank color
export const MAZE_COLS = 9;
export const MAZE_ROWS = 6;

// Rules
export const GRACE_PERIOD_SECONDS = 30;
export const GAME_START_COUNTDOWN_SECONDS = 3;
export const INVITE_EXPIRY_SECONDS = 120;         // 2 minutes
export const RESPAWN_DELAY_MS = 1500;     // ms — delay before respawn after death (practice mode)
export const TIE_WINDOW_MS = 2000;        // ms — if second tank dies within this window it's a tie
export const BATTLE_TRANSITION_DELAY_MS = 1500; // ms — pause in 'resolving' phase before new map
export const BET_AMOUNTS_CENTS = [100, 200, 500] as const;
export type BetAmountCents = (typeof BET_AMOUNTS_CENTS)[number];
export const MIN_DEPOSIT_CENTS = 100;
export const WITHDRAWAL_FEE_CENTS = 25;
export const PLEDGE_FEE_RATE = 0.05;

// Server
export const LIVES_PER_GAME = 5;
export const SERVER_TICK_HZ = 60;
export const SERVER_PATCH_HZ = 20;
export const PHYSICS_STEP = 1 / 60; // shared constant for both client and server
export const BULLET_FIRE_COOLDOWN_MS = 170; // min ms between shots per tank
export const MISSILE_FIRE_EXTRA_COOLDOWN_MS = 100; // extra cooldown after firing a missile to prevent accidental bullet
export const INTERPOLATION_DELAY_MS = 100;
export const SNAP_THRESHOLD_PX = 40; // px — teleport to server if prediction drifts further

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
export const MISSILE_SPEED = 160;                // px/s (~21% faster than original 132)
export const MISSILE_RADIUS = 3;                 // px — collision radius
export const MISSILE_HOMING_DELAY_S = 1;         // seconds before switching to closest-tank homing
export const MISSILE_TURN_SPEED_DEG = 150;       // deg/s — homing turn rate
export const MISSILE_WALL_AVOID_RADIUS = 50;     // px — start dodging walls within this distance
export const MISSILE_WALL_AVOID_STRENGTH = 5;    // avoidance force weight relative to homing force
export const MISSILE_WALL_AVOID_TURN_DEG = 300;  // deg/s — fast turn budget used only for wall avoidance
export const MISSILE_LIFETIME_SECONDS = 12;
export const MISSILE_COLOR = '#f97316';          // orange
