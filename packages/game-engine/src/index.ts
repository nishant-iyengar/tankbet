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
  LIVES_PER_GAME,
  SERVER_TICK_HZ,
  PHYSICS_STEP,
  CORRECTION_DECAY,
  REMOTE_INTERP_DELAY_MS,
  WALL_FRICTION,
  CORNER_SHIELD_PADDING,
  BARREL_WIDTH,
  WALL_LINE_WIDTH,
  COUNTDOWN_OVERLAY_ALPHA,
  HUD_PADDING,
  TANK_COLOR_P1,
  TANK_COLOR_P2,
  RESPAWN_DELAY_MS,
  BULLET_FADE_SECONDS,
  TRACK_LIFETIME_MS,
  TRACK_SPACING,
} from './constants';
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
  advanceBullet,
  shortestAngleDelta,
} from './physics';

export type { Cell, Wall, Maze, LineSegment } from './maze';

export {
  generateMaze,
  mazeToSegments,
  getSpawnPositions,
  getRandomSpawn,
} from './maze';

export type { TrackMark } from './renderer';

export {
  clearCanvas,
  drawMaze,
  drawTank,
  drawBullet,
  drawTracks,
  drawCountdown,
  drawHUD,
  drawExplosion,
  EXPLOSION_DURATION_MS,
} from './renderer';
