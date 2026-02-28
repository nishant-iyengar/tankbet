export {
  CELL_SIZE,
  TANK_WIDTH,
  TANK_HEIGHT,
  BARREL_LENGTH,
  TANK_COLLISION_RADIUS,
  TANK_SPEED,
  TANK_ROTATION_SPEED,
  BULLET_SPEED,
  MAX_BULLETS_PER_TANK,
  BULLET_LIFETIME_SECONDS,
  BULLET_RADIUS,
  MAZE_COLS,
  MAZE_ROWS,
  GRACE_PERIOD_SECONDS,
  GAME_START_COUNTDOWN_SECONDS,
  INVITE_EXPIRY_SECONDS,
  BET_AMOUNTS_CENTS,
  MIN_DEPOSIT_CENTS,
  WITHDRAWAL_FEE_CENTS,
  PLEDGE_FEE_RATE,
  LIVES_PER_GAME,
  SERVER_TICK_HZ,
  CLIENT_FPS,
  INTERPOLATION_DELAY_MS,
  WALL_FRICTION,
  CORNER_SHIELD_PADDING,
  BARREL_WIDTH,
  WALL_LINE_WIDTH,
  COUNTDOWN_OVERLAY_ALPHA,
  HUD_PADDING,
  TANK_COLOR_P1,
  TANK_COLOR_P2,
  RESPAWN_DELAY_MS,
  PowerupType,
  POWERUP_SPAWN_INTERVAL_MIN_S,
  POWERUP_SPAWN_INTERVAL_MAX_S,
  POWERUP_MAX_ON_FIELD,
  POWERUP_COLLECTION_RADIUS,
  MISSILE_SPEED,
  MISSILE_RADIUS,
  MISSILE_HOMING_DELAY_S,
  MISSILE_TURN_SPEED_DEG,
  MISSILE_WALL_LOOKAHEAD,
  MISSILE_LIFETIME_SECONDS,
  MISSILE_COLOR,
} from './constants';
export type { PowerupType as PowerupTypeValue, BetAmountCents } from './constants';

export type {
  Vec2,
  InputState,
  TankState,
  BulletState,
  WallSegment,
  TankOBB,
} from './physics';

export {
  degreesToRadians,
  radiansToDegrees,
  computeTankOBB,
  updateTank,
  updateBullet,
  reflectBullet,
  checkBulletTankCollision,
  createBullet,
  clampTankToMaze,
  collideTankWithWalls,
  extractWallEndpoints,
  collideTankWithEndpoints,
  bulletCrossesWall,
  reflectBulletAtWall,
} from './physics';

export type { Cell, Wall, Maze, LineSegment } from './maze';

export {
  generateMaze,
  mazeToSegments,
  getSpawnPosition,
  getRandomSpawn,
} from './maze';

export {
  clearCanvas,
  drawMaze,
  drawTank,
  drawBullet,
  drawMissile,
  drawPowerup,
  drawTankPowerupIndicator,
  drawCountdown,
  drawHUD,
} from './renderer';

export type { PowerupDef, ActiveEffectData, TankStats } from './powerups';
export { POWERUP_DEFS, resolveStats, randomPowerupType } from './powerups';

export type { MissileState } from './physics';
export {
  createMissile,
  updateMissile,
  checkCircleTankCollision,
} from './physics';
