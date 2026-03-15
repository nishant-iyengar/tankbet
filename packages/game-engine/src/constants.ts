// ─── Shared constants (single source of truth for TypeScript + Python training) ───
// These values are loaded from constants.json so both the game engine and the
// Python RL training environment always use identical physics parameters.
// To change a physics constant: edit constants.json, bump ENV_VERSION.
import _shared from './constants.json';

// Physics
export const CELL_SIZE = _shared.CELL_SIZE;
export const TANK_WIDTH = _shared.TANK_WIDTH;
export const TANK_HEIGHT = _shared.TANK_HEIGHT;
export const BARREL_LENGTH = _shared.BARREL_LENGTH;
export const TANK_SPEED = _shared.TANK_SPEED;
export const REVERSE_SPEED_FACTOR = _shared.REVERSE_SPEED_FACTOR;
export const WALL_FRICTION = _shared.WALL_FRICTION;
export const CORNER_SHIELD_PADDING = _shared.CORNER_SHIELD_PADDING;
export const TANK_ROTATION_SPEED = _shared.TANK_ROTATION_SPEED;
export const BULLET_SPEED = _shared.BULLET_SPEED;
export const MAX_BULLETS_PER_TANK = _shared.MAX_BULLETS_PER_TANK;
export const BULLET_LIFETIME_SECONDS = _shared.BULLET_LIFETIME_SECONDS;
export const BULLET_RADIUS = _shared.BULLET_RADIUS;
export const BULLET_HIT_RADIUS = _shared.BULLET_HIT_RADIUS;
export const TANK_HITBOX_SHRINK = _shared.TANK_HITBOX_SHRINK;
export const MAZE_MIN_WALL_FRACTION = _shared.MAZE_MIN_WALL_FRACTION;
export const MAZE_COLS = _shared.MAZE_COLS;
export const MAZE_ROWS = _shared.MAZE_ROWS;
export const LIVES_PER_GAME = _shared.LIVES_PER_GAME;
export const SERVER_TICK_HZ = _shared.SERVER_TICK_HZ;
export const TIE_WINDOW_MS = _shared.TIE_WINDOW_MS;
export const BULLET_FIRE_COOLDOWN_MS = _shared.BULLET_FIRE_COOLDOWN_MS;

// Derived
export const PHYSICS_STEP = 1 / SERVER_TICK_HZ;

// ─── TypeScript-only constants (not needed for Python training) ───

// Visual
export const BULLET_LENGTH = 10;           // visual length of bullet shape (px)
export const BULLET_WIDTH = 4;             // visual width of bullet body (px)
export const BARREL_WIDTH = 5;            // px — barrel rectangle height in renderer
export const WALL_LINE_WIDTH = 2;         // px — wall stroke width in renderer
export const COUNTDOWN_OVERLAY_ALPHA = 0.6;
export const HUD_PADDING = 10;
export const TANK_COLOR_P1 = '#4ade80';   // green — player 1 tank color
export const TANK_COLOR_P2 = '#f87171';   // red   — player 2 tank color

// Rules (server/client only)
export const GRACE_PERIOD_SECONDS = 30;
export const GAME_START_COUNTDOWN_SECONDS = 3;
export const INVITE_EXPIRY_SECONDS = 120;
export const RESPAWN_DELAY_MS = 1500;
export const BATTLE_TRANSITION_DELAY_MS = 1500;
export const LIVES_PER_TEST_GAME = 10;
export const CORRECTION_DECAY = 0.92;
export const REMOTE_INTERP_DELAY_MS = 150;
export const BULLET_FADE_SECONDS = 0.25;
export const TRACK_LIFETIME_MS = 2000;
export const TRACK_SPACING = 8;

// Lag compensation
export const POSITION_HISTORY_SIZE = 128;
export const LAG_COMP_MAX_REWIND_MS = 600;
export const REWIND_DECAY_MS = 500;

// Room lifecycle
export const GAME_END_DISCONNECT_DELAY_MS = 5000;
export const CLEANUP_JOB_INTERVAL_MS = 30_000;
export const ORPHANED_GAME_THRESHOLD_MS = 15 * 60 * 1000;
