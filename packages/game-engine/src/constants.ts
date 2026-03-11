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
export const BULLET_SPEED = 225;          // px/s
export const MAX_BULLETS_PER_TANK = 10;
export const BULLET_LIFETIME_SECONDS = 8; // time-based; bounces are infinite
export const BULLET_RADIUS = 3;            // visual radius (drawn on canvas)
export const BULLET_HIT_RADIUS = 7;       // collision radius — generous to compensate for client-server position desync
export const TANK_HITBOX_SHRINK = 1;      // px shrunk per side for damage hitbox (~90% of visual)
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
// Server
export const LIVES_PER_GAME = 5;
export const LIVES_PER_TEST_GAME = 2;  // used by dev test-game mode
export const SERVER_TICK_HZ = 60;
export const PHYSICS_STEP = 1 / SERVER_TICK_HZ;
export const CORRECTION_DECAY = 0.92;        // per physics step — error *= 0.92, ~8% removed each step (~95% settled in ~350ms)
export const BULLET_CORRECTION_DECAY = 0.85; // bullets correct faster (~95% settled in ~170ms)
export const REMOTE_INTERP_DELAY_MS = 400;   // render remote tank 400ms in the past
export const BULLET_FADE_SECONDS = 0.25;     // fade out over the last N seconds of lifetime
export const TRACK_LIFETIME_MS = 2000;       // tank tracks visible for 2 seconds
export const TRACK_SPACING = 8;              // px — minimum distance between track marks
export const BULLET_FIRE_COOLDOWN_MS = 200;  // min ms between shots per tank

// Lag compensation
export const POSITION_HISTORY_SIZE = 128;       // ring buffer capacity (~2s at 60Hz)
export const LAG_COMP_MAX_REWIND_MS = 600;      // max rewind cap to prevent abuse

// Room lifecycle
export const GAME_END_DISCONNECT_DELAY_MS = 5000;  // ms — delay before disposing room after game ends
export const CLEANUP_JOB_INTERVAL_MS = 30_000;     // ms — how often the orphan/stale-invite job runs
export const ORPHANED_GAME_THRESHOLD_MS = 15 * 60 * 1000; // 15 min — max time before orphaned game is forfeited
