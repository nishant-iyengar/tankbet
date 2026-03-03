// Physics
export const CELL_SIZE = 120;
export const TANK_WIDTH = 20;
export const TANK_HEIGHT = 20;
export const BARREL_LENGTH = 18;
export const TANK_COLLISION_RADIUS = 10; // kept for reference; physics uses OBB+barrel dynamically
export const TANK_SPEED = 165;            // px/s
export const WALL_FRICTION = 1.0;          // fraction of slide speed removed when touching a wall (was 0.55)
export const CORNER_SHIELD_PADDING = 4;   // extra px beyond OBB to keep tank away from wall endpoints
export const TANK_ROTATION_SPEED = 200;   // deg/s
export const BULLET_SPEED = 300;          // px/s
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
export const SERVER_TICK_HZ = 100;
export const PHYSICS_STEP = 1 / SERVER_TICK_HZ;
export const BULLET_FIRE_COOLDOWN_MS = 170; // min ms between shots per tank
export const BULLET_CORRECTION_INTERVAL_TICKS = 50; // server sends position corrections every 50 ticks (500ms at 100Hz)
export const BULLET_CORRECTION_BLEND_RATE = 0.15; // fraction of error corrected per physics step (smooth convergence)
