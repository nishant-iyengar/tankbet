/**
 * Build the 147-dim observation vector for the bot's neural network.
 * Port of training/tank_env.py _get_observation() to TypeScript.
 *
 * All observations are from the bot's (ego) perspective, rotated into ego frame.
 */
import {
  CELL_SIZE,
  MAZE_COLS,
  MAZE_ROWS,
  TANK_SPEED,
  TANK_WIDTH,
  BARREL_LENGTH,
  BULLET_SPEED,
  BULLET_LIFETIME_SECONDS,
  BULLET_FIRE_COOLDOWN_MS,
  BULLET_RADIUS,
  BULLET_HIT_RADIUS,
  BULLET_WALL_CLEARANCE,
  TANK_HITBOX_SHRINK,
  MAX_BULLETS_PER_TANK,
  MAX_BULLET_BOUNCES,
  SERVER_TICK_HZ,
  THREAT_RADIUS_ENEMY,
  THREAT_RADIUS_SELF,
  THREAT_HEADING_THRESHOLD,
} from '@tankbet/game-engine/constants';
import type { BulletState, WallSegment } from '@tankbet/game-engine/physics';
import type { Maze, Wall } from '@tankbet/game-engine/maze';

const ARENA_W = MAZE_COLS * CELL_SIZE;
const ARENA_H = MAZE_ROWS * CELL_SIZE;
const MAX_DIST = Math.hypot(ARENA_W, ARENA_H);

const OBS_DIM = 147;
const BULLET_OBS_SLOTS = 6;
const WALL_GRID_RADIUS = 2;
const BFS_SUB_GRID = 4;
const FIRE_COOLDOWN_TICKS = Math.round((BULLET_FIRE_COOLDOWN_MS / 1000) * SERVER_TICK_HZ);

export interface BotTankState {
  x: number;
  y: number;
  angle: number; // degrees
  speed: number;
  alive: boolean;
  sessionId: string;
}

interface WallLookup {
  [key: string]: { top: boolean; right: boolean };
}

/**
 * Pre-computed wall lookup for BFS and local wall grid.
 * Call once per maze, cache the result.
 */
export function buildWallLookup(maze: Maze): WallLookup {
  const lookup: WallLookup = {};
  for (const w of maze.walls) {
    const fromRow = w.from.row;
    const fromCol = w.from.col;
    const toRow = w.to.row;
    const toCol = w.to.col;

    if (w.axis === 'v') {
      const r = fromRow;
      const c = Math.min(fromCol, toCol);
      const key = `${r},${c}`;
      if (!lookup[key]) lookup[key] = { top: false, right: false };
      lookup[key].right = true;
    } else if (w.axis === 'h') {
      const r = Math.max(fromRow, toRow);
      const c = fromCol;
      const key = `${r},${c}`;
      if (!lookup[key]) lookup[key] = { top: false, right: false };
      lookup[key].top = true;
    }
  }
  return lookup;
}

function hasWall(lookup: WallLookup, row: number, col: number, side: 'top' | 'right'): boolean {
  if (side === 'top' && row === 0) return true;
  if (side === 'right' && col === MAZE_COLS - 1) return true;
  const cell = lookup[`${row},${col}`];
  if (!cell) return false;
  return cell[side];
}

function canMove(lookup: WallLookup, row: number, col: number, direction: string): boolean {
  if (direction === 'up') {
    if (row === 0) return false;
    return !hasWall(lookup, row, col, 'top');
  } else if (direction === 'down') {
    if (row >= MAZE_ROWS - 1) return false;
    return !hasWall(lookup, row + 1, col, 'top');
  } else if (direction === 'left') {
    if (col === 0) return false;
    return !hasWall(lookup, row, col - 1, 'right');
  } else if (direction === 'right') {
    if (col >= MAZE_COLS - 1) return false;
    return !hasWall(lookup, row, col, 'right');
  }
  return false;
}

// --- Ray/segment intersection helpers ---

function raySegmentIntersect(
  ox: number, oy: number, dx: number, dy: number,
  sx1: number, sy1: number, sx2: number, sy2: number,
): number | null {
  const dsx = sx2 - sx1;
  const dsy = sy2 - sy1;
  const denom = dx * dsy - dy * dsx;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((sx1 - ox) * dsy - (sy1 - oy) * dsx) / denom;
  const u = ((sx1 - ox) * dy - (sy1 - oy) * dx) / denom;
  if (t >= 0 && u >= 0 && u <= 1) return t;
  return null;
}

function raycastWallDistance(
  x: number, y: number, angleDeg: number, maxDist: number, segments: WallSegment[],
): number {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  let best = maxDist;
  for (const seg of segments) {
    const t = raySegmentIntersect(x, y, dx, dy, seg.x1, seg.y1, seg.x2, seg.y2);
    if (t !== null && t < best) best = t;
  }
  return best;
}

function segmentsIntersect(
  ax1: number, ay1: number, ax2: number, ay2: number,
  bx1: number, by1: number, bx2: number, by2: number,
): boolean {
  function cross(ox: number, oy: number, px: number, py: number, qx: number, qy: number): number {
    return (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  }
  const d1 = cross(bx1, by1, bx2, by2, ax1, ay1);
  const d2 = cross(bx1, by1, bx2, by2, ax2, ay2);
  const d3 = cross(ax1, ay1, ax2, ay2, bx1, by1);
  const d4 = cross(ax1, ay1, ax2, ay2, bx2, by2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function lineSegmentCrossesAnyWall(
  x1: number, y1: number, x2: number, y2: number, segments: WallSegment[],
): boolean {
  for (const seg of segments) {
    if (segmentsIntersect(x1, y1, x2, y2, seg.x1, seg.y1, seg.x2, seg.y2)) {
      return true;
    }
  }
  return false;
}

function bulletHeadingToward(
  egoX: number, egoY: number,
  bx: number, by: number, bvx: number, bvy: number,
): number {
  const dx = egoX - bx;
  const dy = egoY - by;
  const d = Math.hypot(dx, dy);
  if (d === 0) return 0;
  const bspd = Math.hypot(bvx, bvy);
  if (bspd === 0) return 0;
  return (bvx * dx + bvy * dy) / (bspd * d);
}

function pointToSegmentDistance(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abSq = abx * abx + aby * aby;
  if (abSq < 1e-12) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / abSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

// --- BFS pathfinding ---

function bfsPathDirection(
  egoX: number, egoY: number, oppX: number, oppY: number,
  wallLookup: WallLookup,
): [number, number, number] {
  const subSize = CELL_SIZE / BFS_SUB_GRID;
  const totalSr = MAZE_ROWS * BFS_SUB_GRID;
  const totalSc = MAZE_COLS * BFS_SUB_GRID;

  const egoSr = Math.min(Math.max(Math.floor(egoY / subSize), 0), totalSr - 1);
  const egoSc = Math.min(Math.max(Math.floor(egoX / subSize), 0), totalSc - 1);
  const oppSr = Math.min(Math.max(Math.floor(oppY / subSize), 0), totalSr - 1);
  const oppSc = Math.min(Math.max(Math.floor(oppX / subSize), 0), totalSc - 1);

  if (egoSr === oppSr && egoSc === oppSc) return [0, 0, 0];

  // BFS on sub-grid
  const startKey = egoSr * totalSc + egoSc;
  const goalKey = oppSr * totalSc + oppSc;
  const visited = new Set<number>([startKey]);
  const parent = new Map<number, number>();
  const queue: number[] = [startKey];
  let head = 0;

  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
  const dirNames = ['up', 'down', 'left', 'right'] as const;

  while (head < queue.length) {
    const current = queue[head]!;
    head++;
    const sr = Math.floor(current / totalSc);
    const sc = current % totalSc;

    if (current === goalKey) break;

    for (let d = 0; d < 4; d++) {
      const dr = dirs[d]![0];
      const dc = dirs[d]![1];
      const nsr = sr + dr;
      const nsc = sc + dc;
      if (nsr < 0 || nsr >= totalSr || nsc < 0 || nsc >= totalSc) continue;
      const nKey = nsr * totalSc + nsc;
      if (visited.has(nKey)) continue;

      // Check wall only when crossing a maze cell boundary
      const mazeR1 = Math.floor(sr / BFS_SUB_GRID);
      const mazeC1 = Math.floor(sc / BFS_SUB_GRID);
      const mazeR2 = Math.floor(nsr / BFS_SUB_GRID);
      const mazeC2 = Math.floor(nsc / BFS_SUB_GRID);
      if (mazeR1 !== mazeR2 || mazeC1 !== mazeC2) {
        if (!canMove(wallLookup, mazeR1, mazeC1, dirNames[d]!)) continue;
      }

      visited.add(nKey);
      parent.set(nKey, current);
      queue.push(nKey);
    }
  }

  if (!parent.has(goalKey)) return [0, 0, 1]; // unreachable

  // Walk back from goal to find the sub-cell right after start
  let cell = goalKey;
  let pathLen = 0;
  while (parent.get(cell) !== startKey) {
    cell = parent.get(cell)!;
    pathLen++;
  }
  pathLen++;

  const nextSr = Math.floor(cell / totalSc);
  const nextSc = cell % totalSc;
  const targetX = nextSc * subSize + subSize / 2;
  const targetY = nextSr * subSize + subSize / 2;
  const dx = targetX - egoX;
  const dy = targetY - egoY;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return [0, 0, 0];

  const worldAngle = Math.atan2(dy, dx);
  const maxPath = totalSr * totalSc;
  const normDist = Math.min(pathLen / maxPath, 1);

  return [Math.cos(worldAngle), Math.sin(worldAngle), normDist];
}

// --- Firing solution tracer ---

function traceFiringSolution(
  ego: BotTankState, opp: BotTankState, segments: WallSegment[],
): [number, number, number] {
  if (!ego.alive || !opp.alive) return [0, 0, 0];

  const rad = (ego.angle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const spawnDist = BARREL_LENGTH + TANK_WIDTH / 2;
  let x = ego.x + cosA * spawnDist;
  let y = ego.y + sinA * spawnDist;
  let vx = cosA;
  let vy = sinA;

  // Check if barrel tip spawns through a wall
  let bounceCount = 0;
  for (const seg of segments) {
    const crossed = bulletCrossesWallSimple(ego.x, ego.y, x, y, seg);
    if (crossed) {
      const eps = BULLET_RADIUS + BULLET_WALL_CLEARANCE;
      if (seg.x1 === seg.x2) {
        vx = -vx;
        x = crossed.hitX + (vx > 0 ? eps : -eps);
        y = crossed.hitY;
      } else {
        vy = -vy;
        x = crossed.hitX;
        y = crossed.hitY + (vy > 0 ? eps : -eps);
      }
      bounceCount = 1;
      break;
    }
  }

  const maxTravel = BULLET_SPEED * BULLET_LIFETIME_SECONDS;
  const hitRadius = BULLET_HIT_RADIUS + TANK_WIDTH / 2 - TANK_HITBOX_SHRINK;
  let totalDist = 0;
  let foundOppHit = false;
  let oppNormDist = 0;
  let foundSelfHit = false;

  for (let bounce = 0; bounce < MAX_BULLET_BOUNCES; bounce++) {
    // Find nearest wall hit along current ray direction
    let bestT = Infinity;
    let bestSeg: WallSegment | null = null;
    for (const seg of segments) {
      const t = raySegmentIntersect(x, y, vx, vy, seg.x1, seg.y1, seg.x2, seg.y2);
      if (t !== null && t > 0.5 && t < bestT) {
        bestT = t;
        bestSeg = seg;
      }
    }

    const remaining = maxTravel - totalDist;
    if (remaining <= 0) break;
    const segLen = bestT < Infinity ? Math.min(bestT, remaining) : remaining;
    const endX = x + vx * segLen;
    const endY = y + vy * segLen;

    // Check if opponent is within hit_radius of this segment
    if (!foundOppHit) {
      const dist = pointToSegmentDistance(opp.x, opp.y, x, y, endX, endY);
      if (dist < hitRadius) {
        foundOppHit = true;
        oppNormDist = Math.min((totalDist + segLen) / maxTravel, 1);
      }
    }

    // Check if ego is within hit_radius (only after a bounce)
    if (!foundSelfHit && bounceCount >= 1) {
      const selfDist = pointToSegmentDistance(ego.x, ego.y, x, y, endX, endY);
      if (selfDist < hitRadius) {
        foundSelfHit = true;
      }
    }

    if (foundOppHit && foundSelfHit) break;

    totalDist += segLen;
    if (totalDist >= maxTravel) break;
    if (bestSeg === null || bestT >= remaining) break;

    // Reflect off wall
    const wallX = x + vx * bestT;
    const wallY = y + vy * bestT;
    const eps = BULLET_RADIUS + BULLET_WALL_CLEARANCE;
    if (bestSeg.x1 === bestSeg.x2) {
      vx = -vx;
      x = wallX + (vx > 0 ? eps : -eps);
      y = wallY;
    } else {
      vy = -vy;
      x = wallX;
      y = wallY + (vy > 0 ? eps : -eps);
    }
    bounceCount++;
  }

  return [
    foundOppHit ? 1 : 0,
    oppNormDist,
    foundSelfHit ? 1 : 0,
  ];
}

function bulletCrossesWallSimple(
  prevX: number, prevY: number, nextX: number, nextY: number, wall: WallSegment,
): { hitX: number; hitY: number } | null {
  if (wall.x1 === wall.x2) {
    const wx = wall.x1;
    const minY = Math.min(wall.y1, wall.y2);
    const maxY = Math.max(wall.y1, wall.y2);
    if (Math.min(prevX, nextX) <= wx && Math.max(prevX, nextX) >= wx) {
      const dx = nextX - prevX;
      if (Math.abs(dx) < 0.001) return null;
      const t = (wx - prevX) / dx;
      const hitY = prevY + t * (nextY - prevY);
      if (hitY >= minY && hitY <= maxY) return { hitX: wx, hitY };
    }
  } else if (wall.y1 === wall.y2) {
    const wy = wall.y1;
    const minX = Math.min(wall.x1, wall.x2);
    const maxX = Math.max(wall.x1, wall.x2);
    if (Math.min(prevY, nextY) <= wy && Math.max(prevY, nextY) >= wy) {
      const dy = nextY - prevY;
      if (Math.abs(dy) < 0.001) return null;
      const t = (wy - prevY) / dy;
      const hitX = prevX + t * (nextX - prevX);
      if (hitX >= minX && hitX <= maxX) return { hitX, hitY: wy };
    }
  }
  return null;
}

// --- Main observation builder ---

export function buildObservation(
  ego: BotTankState,
  opp: BotTankState,
  bullets: BulletState[],
  segments: WallSegment[],
  wallLookup: WallLookup,
  ticksSinceLastFired: number,
  canFire: boolean,
  tickRatio: number,
  ammoFraction: number,
): Float32Array {
  const obs = new Float32Array(OBS_DIM);
  let idx = 0;

  const egoRad = (ego.angle * Math.PI) / 180;
  const cosEgo = Math.cos(egoRad);
  const sinEgo = Math.sin(egoRad);

  // --- Ego tank (7 values) [0..6] ---
  obs[idx++] = ego.x / ARENA_W;
  obs[idx++] = ego.y / ARENA_H;
  obs[idx++] = cosEgo;
  obs[idx++] = sinEgo;
  obs[idx++] = ego.speed / TANK_SPEED;
  obs[idx++] = ego.alive ? 1 : 0;
  obs[idx++] = canFire ? 1 : 0;

  // --- Opponent (ego-centric) (8 values) [7..14] ---
  const relXWorld = opp.x - ego.x;
  const relYWorld = opp.y - ego.y;
  const relXEgo = relXWorld * cosEgo + relYWorld * sinEgo;
  const relYEgo = -relXWorld * sinEgo + relYWorld * cosEgo;
  obs[idx++] = relXEgo / MAX_DIST;
  obs[idx++] = relYEgo / MAX_DIST;
  const relAngle = opp.angle - ego.angle;
  const relAngleRad = (relAngle * Math.PI) / 180;
  obs[idx++] = Math.cos(relAngleRad);
  obs[idx++] = Math.sin(relAngleRad);
  obs[idx++] = opp.speed / TANK_SPEED;
  obs[idx++] = opp.alive ? 1 : 0;
  const bearingRad = Math.atan2(relYEgo, relXEgo);
  obs[idx++] = Math.cos(bearingRad);
  obs[idx++] = Math.sin(bearingRad);

  // --- Bullets (6 closest x 6 values = 36) [15..50] ---
  const bulletData: { dist: number; bullet: BulletState }[] = [];
  for (const b of bullets) {
    const dist = Math.hypot(b.x - ego.x, b.y - ego.y);
    bulletData.push({ dist, bullet: b });
  }
  bulletData.sort((a, b) => a.dist - b.dist);

  for (let i = 0; i < BULLET_OBS_SLOTS; i++) {
    if (i < bulletData.length) {
      const b = bulletData[i]!.bullet;
      const bRelX = b.x - ego.x;
      const bRelY = b.y - ego.y;
      const bEgoX = bRelX * cosEgo + bRelY * sinEgo;
      const bEgoY = -bRelX * sinEgo + bRelY * cosEgo;
      obs[idx++] = bEgoX / MAX_DIST;
      obs[idx++] = bEgoY / MAX_DIST;
      const bVxEgo = b.vx * cosEgo + b.vy * sinEgo;
      const bVyEgo = -b.vx * sinEgo + b.vy * cosEgo;
      obs[idx++] = bVxEgo / BULLET_SPEED;
      obs[idx++] = bVyEgo / BULLET_SPEED;
      // Owner: 1 if ego's bullet, -1 if opponent's
      obs[idx++] = b.ownerId === ego.sessionId ? 1 : -1;
      obs[idx++] = bulletHeadingToward(ego.x, ego.y, b.x, b.y, b.vx, b.vy);
    } else {
      idx += 6; // zeros (Float32Array is zero-initialized)
    }
  }

  // --- Local wall grid (5x5 x 2 = 50 values) [51..100] ---
  const egoCol = Math.floor(ego.x / CELL_SIZE);
  const egoRow = Math.floor(ego.y / CELL_SIZE);
  for (let dr = -WALL_GRID_RADIUS; dr <= WALL_GRID_RADIUS; dr++) {
    for (let dc = -WALL_GRID_RADIUS; dc <= WALL_GRID_RADIUS; dc++) {
      const r = egoRow + dr;
      const c = egoCol + dc;
      if (r >= 0 && r < MAZE_ROWS && c >= 0 && c < MAZE_COLS) {
        obs[idx++] = hasWall(wallLookup, r, c, 'top') ? 1 : 0;
        obs[idx++] = hasWall(wallLookup, r, c, 'right') ? 1 : 0;
      } else {
        obs[idx++] = 1; // border = wall
        obs[idx++] = 1;
      }
    }
  }

  // --- Metadata (3 values) [101..103] ---
  obs[idx++] = tickRatio;
  let egoBullets = 0;
  let oppBullets = 0;
  for (const b of bullets) {
    if (b.ownerId === ego.sessionId) egoBullets++;
    else oppBullets++;
  }
  obs[idx++] = egoBullets / MAX_BULLETS_PER_TANK;
  obs[idx++] = oppBullets / MAX_BULLETS_PER_TANK;

  // --- Line of sight to opponent (2 values) [104..105] ---
  if (opp.alive) {
    const hasLos = !lineSegmentCrossesAnyWall(ego.x, ego.y, opp.x, opp.y, segments);
    const dist = Math.hypot(opp.x - ego.x, opp.y - ego.y);
    obs[idx++] = hasLos ? 1 : 0;
    obs[idx++] = hasLos ? dist / MAX_DIST : 0;
  } else {
    idx += 2;
  }

  // --- Wall raycasts in 12 directions (12 values) [106..117] ---
  for (let offsetDeg = 0; offsetDeg < 360; offsetDeg += 30) {
    const rayAngle = ego.angle + offsetDeg;
    const wallDist = raycastWallDistance(ego.x, ego.y, rayAngle, MAX_DIST, segments);
    obs[idx++] = wallDist / MAX_DIST;
  }

  // --- BFS compass to opponent (3 values) [118..120] ---
  let relCos = 0;
  let relSin = 0;
  if (opp.alive) {
    const [cosDir, sinDir, pathDist] = bfsPathDirection(ego.x, ego.y, opp.x, opp.y, wallLookup);
    relCos = cosDir * cosEgo + sinDir * sinEgo;
    relSin = -cosDir * sinEgo + sinDir * cosEgo;
    obs[idx++] = relCos;
    obs[idx++] = relSin;
    obs[idx++] = pathDist;
  } else {
    idx += 3;
  }

  // --- BFS quadrant hint (4 values) [121..124] ---
  const bfsAngle = Math.atan2(relSin, relCos);
  if (Math.abs(relCos) < 0.01 && Math.abs(relSin) < 0.01) {
    idx += 4; // zeros
  } else if (Math.abs(bfsAngle) < Math.PI / 4) {
    obs[idx++] = 1; // forward
    idx += 3;
  } else if (bfsAngle < -(3 * Math.PI / 4) || bfsAngle > (3 * Math.PI / 4)) {
    idx += 3;
    obs[idx++] = 1; // backward
  } else if (relSin < 0) {
    idx += 1;
    obs[idx++] = 1; // left
    idx += 2;
  } else {
    idx += 2;
    obs[idx++] = 1; // right
    idx += 1;
  }

  // --- Aim alignment (2 values) [125..126] ---
  const barrelAngle = egoRad;
  let distToOpp = 0;
  let bearing = 0;
  if (opp.alive) {
    const dx = opp.x - ego.x;
    const dy = opp.y - ego.y;
    distToOpp = Math.hypot(dx, dy);
    bearing = Math.atan2(dy, dx);
    const aimDiff = barrelAngle - bearing;
    obs[idx++] = Math.cos(aimDiff);
    obs[idx++] = Math.sin(aimDiff);
  } else {
    idx += 2;
  }

  // --- Lead angle (3 values) [127..129] ---
  if (opp.alive && distToOpp > 1) {
    const oppRad = (opp.angle * Math.PI) / 180;
    const oppVx = opp.speed * Math.cos(oppRad);
    const oppVy = opp.speed * Math.sin(oppRad);
    let t = distToOpp / BULLET_SPEED;
    let predX = 0;
    let predY = 0;
    for (let iter = 0; iter < 2; iter++) {
      predX = opp.x + oppVx * t;
      predY = opp.y + oppVy * t;
      t = Math.hypot(predX - ego.x, predY - ego.y) / BULLET_SPEED;
    }
    const leadBearing = Math.atan2(predY - ego.y, predX - ego.x);
    const leadRel = leadBearing - barrelAngle;
    obs[idx++] = Math.cos(leadRel);
    obs[idx++] = Math.sin(leadRel);
    obs[idx++] = Math.sin(barrelAngle - leadBearing);
  } else {
    idx += 3;
  }

  // --- Shot difficulty (2 values) [130..131] ---
  if (opp.alive && distToOpp > 1) {
    obs[idx++] = Math.atan2(TANK_WIDTH, distToOpp) / Math.PI;
    obs[idx++] = Math.min(distToOpp / BULLET_SPEED / BULLET_LIFETIME_SECONDS, 1);
  } else {
    idx += 2;
  }

  // --- Threat awareness: enemy bullets (4 values) [132..135] ---
  let threatCount = 0;
  let nearestThreatDist = 1;
  let nearestThreatAngleCos = 0;
  let nearestThreatAngleSin = 0;
  for (const b of bullets) {
    if (b.ownerId === ego.sessionId) continue;
    const bDist = Math.hypot(b.x - ego.x, b.y - ego.y);
    const heading = bulletHeadingToward(ego.x, ego.y, b.x, b.y, b.vx, b.vy);
    if (bDist <= THREAT_RADIUS_ENEMY && heading > THREAT_HEADING_THRESHOLD) {
      threatCount++;
      const normDist = bDist / THREAT_RADIUS_ENEMY;
      if (normDist < nearestThreatDist) {
        nearestThreatDist = normDist;
        const tDx = b.x - ego.x;
        const tDy = b.y - ego.y;
        const tEgoX = tDx * cosEgo + tDy * sinEgo;
        const tEgoY = -tDx * sinEgo + tDy * cosEgo;
        const tAngle = Math.atan2(tEgoY, tEgoX);
        nearestThreatAngleCos = Math.cos(tAngle);
        nearestThreatAngleSin = Math.sin(tAngle);
      }
    }
  }
  obs[idx++] = Math.min(threatCount / MAX_BULLETS_PER_TANK, 1);
  obs[idx++] = threatCount > 0 ? nearestThreatDist : 0;
  obs[idx++] = nearestThreatAngleCos;
  obs[idx++] = nearestThreatAngleSin;

  // --- Self-bullet threat (4 values) [136..139] ---
  let selfThreatCount = 0;
  let nearestSelfDist = 1;
  let nearestSelfAngleCos = 0;
  let nearestSelfAngleSin = 0;
  for (const b of bullets) {
    if (b.ownerId !== ego.sessionId) continue;
    const bDist = Math.hypot(b.x - ego.x, b.y - ego.y);
    const heading = bulletHeadingToward(ego.x, ego.y, b.x, b.y, b.vx, b.vy);
    if (bDist <= THREAT_RADIUS_SELF && heading > THREAT_HEADING_THRESHOLD) {
      selfThreatCount++;
      const normDist = bDist / THREAT_RADIUS_SELF;
      if (normDist < nearestSelfDist) {
        nearestSelfDist = normDist;
        const sDx = b.x - ego.x;
        const sDy = b.y - ego.y;
        const sEgoX = sDx * cosEgo + sDy * sinEgo;
        const sEgoY = -sDx * sinEgo + sDy * cosEgo;
        const sAngle = Math.atan2(sEgoY, sEgoX);
        nearestSelfAngleCos = Math.cos(sAngle);
        nearestSelfAngleSin = Math.sin(sAngle);
      }
    }
  }
  obs[idx++] = Math.min(selfThreatCount / MAX_BULLETS_PER_TANK, 1);
  obs[idx++] = selfThreatCount > 0 ? nearestSelfDist : 0;
  obs[idx++] = nearestSelfAngleCos;
  obs[idx++] = nearestSelfAngleSin;

  // --- Tactical (2 values) [140..141] ---
  obs[idx++] = FIRE_COOLDOWN_TICKS > 0
    ? Math.min(ticksSinceLastFired / FIRE_COOLDOWN_TICKS, 1)
    : 1;
  if (opp.alive) {
    const oppRad = (opp.angle * Math.PI) / 180;
    const oppToEgoAngle = Math.atan2(ego.y - opp.y, ego.x - opp.x);
    obs[idx++] = Math.cos(oppRad - oppToEgoAngle);
  } else {
    idx += 1;
  }

  // --- Barrel wall distance (1 value) [142] ---
  const barrelWall = raycastWallDistance(ego.x, ego.y, ego.angle, MAX_DIST, segments);
  obs[idx++] = barrelWall / MAX_DIST;

  // --- Firing solution (3 values) [143..145] ---
  const [shotHit, shotDist, shotSelf] = traceFiringSolution(ego, opp, segments);
  obs[idx++] = shotHit;
  obs[idx++] = shotDist;
  obs[idx++] = shotSelf;

  // --- Ammo fraction (1 value) [146] ---
  obs[idx++] = ammoFraction;

  // Clip to [-1, 1]
  for (let i = 0; i < OBS_DIM; i++) {
    obs[i] = Math.max(-1, Math.min(1, obs[i]!));
  }

  return obs;
}
