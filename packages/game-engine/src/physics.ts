import {
  TANK_SPEED,
  TANK_ROTATION_SPEED,
  BULLET_SPEED,
  BARREL_LENGTH,
  TANK_WIDTH,
  TANK_HEIGHT,
  BULLET_RADIUS,
  BULLET_HIT_RADIUS,
  TANK_HITBOX_SHRINK,
  BULLET_LIFETIME_SECONDS,
  WALL_FRICTION,
  CORNER_SHIELD_PADDING,
  BULLET_FIRE_COOLDOWN_MS,
  MAX_BULLETS_PER_TANK,
  BARREL_WIDTH,
  REVERSE_SPEED_FACTOR,
} from './constants';

export type Vec2 = { x: number; y: number };

export type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
};

export type TankState = {
  id: string;
  x: number;
  y: number;
  angle: number; // degrees, 0 = right
  speed: number;
};

export type BulletState = {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number; // seconds since fired
};

export type WallSegment = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radiansToDegrees(rad: number): number {
  return rad * (180 / Math.PI);
}

export type TankOBB = { rad: number; cosA: number; sinA: number; obb: number };

export function computeTankOBB(angle: number): TankOBB {
  const rad = degreesToRadians(angle);
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));
  const obb = (TANK_WIDTH / 2) * (cosA + sinA);
  return { rad, cosA, sinA, obb };
}

export function updateTank(tank: TankState, input: InputState, dt: number): TankState {
  let angle = tank.angle;

  if (input.left) {
    angle -= TANK_ROTATION_SPEED * dt;
  }
  if (input.right) {
    angle += TANK_ROTATION_SPEED * dt;
  }

  // Normalize angle to [0, 360)
  angle = ((angle % 360) + 360) % 360;

  let speed = 0;
  if (input.up) {
    speed = TANK_SPEED;
  } else if (input.down) {
    speed = -TANK_SPEED * REVERSE_SPEED_FACTOR;
  }

  const rad = degreesToRadians(angle);
  const x = tank.x + Math.cos(rad) * speed * dt;
  const y = tank.y + Math.sin(rad) * speed * dt;

  return { id: tank.id, x, y, angle, speed };
}

export function updateBullet(bullet: BulletState, dt: number): BulletState {
  return {
    id: bullet.id,
    ownerId: bullet.ownerId,
    x: bullet.x + bullet.vx * dt,
    y: bullet.y + bullet.vy * dt,
    vx: bullet.vx,
    vy: bullet.vy,
    age: bullet.age + dt,
  };
}

export function reflectBullet(bullet: BulletState, wall: WallSegment): BulletState {
  const isHorizontal = wall.y1 === wall.y2;
  const isVertical = wall.x1 === wall.x2;

  let vx = bullet.vx;
  let vy = bullet.vy;

  if (isHorizontal) {
    vy = -vy;
  } else if (isVertical) {
    vx = -vx;
  }

  return {
    id: bullet.id,
    ownerId: bullet.ownerId,
    x: bullet.x,
    y: bullet.y,
    vx,
    vy,
    age: bullet.age,
  };
}

// Circle vs axis-aligned rect helper (in local space)
function circleAABBOverlap(
  cx: number, cy: number, r: number,
  minX: number, minY: number, maxX: number, maxY: number,
): boolean {
  const closestX = Math.max(minX, Math.min(cx, maxX));
  const closestY = Math.max(minY, Math.min(cy, maxY));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= r * r;
}

// Segment vs axis-aligned rect intersection (Liang-Barsky). Returns true if the
// line segment from (x0,y0)→(x1,y1) intersects the AABB [minX,maxX]×[minY,maxY].
function segmentAABBIntersects(
  x0: number, y0: number, x1: number, y1: number,
  minX: number, minY: number, maxX: number, maxY: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let tMin = 0;
  let tMax = 1;

  // Check each edge: left, right, bottom, top
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - minX, maxX - x0, y0 - minY, maxY - y0];

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]!) < 1e-10) {
      // Parallel to this edge — reject if outside
      if (q[i]! < 0) return false;
    } else {
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) {
        tMin = Math.max(tMin, t);
      } else {
        tMax = Math.min(tMax, t);
      }
      if (tMin > tMax) return false;
    }
  }

  return true;
}

export function checkBulletTankCollision(
  bullet: BulletState,
  tank: TankState,
  walls?: WallSegment[],
  prevBulletX?: number,
  prevBulletY?: number,
): boolean {
  // Transform bullet into tank-local coordinates (tank at origin, angle 0)
  const rad = degreesToRadians(tank.angle);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const relX = bullet.x - tank.x;
  const relY = bullet.y - tank.y;
  const localX = relX * cos + relY * sin;
  const localY = -relX * sin + relY * cos;

  // Body-only hitbox, shrunk slightly from visual for forgiving near-misses.
  // Barrel is excluded from damage detection — barrel-tip hits feel random,
  // not skillful, and every major tank game (Tank Trouble, Wii Tanks, Diep.io)
  // uses body-only hitboxes.
  const halfW = TANK_WIDTH / 2 - TANK_HITBOX_SHRINK;
  const halfH = TANK_HEIGHT / 2 - TANK_HITBOX_SHRINK;

  // Use BULLET_HIT_RADIUS (larger than visual) so near-hits connect — favors the shooter
  let hit = circleAABBOverlap(localX, localY, BULLET_HIT_RADIUS, -halfW, -halfH, halfW, halfH);

  // Sweep test: if the point test missed, check whether the bullet's travel
  // path (prevPosition → currentPosition) crossed through the tank hitbox.
  // This catches fast pass-throughs that skip over the hitbox in one tick.
  if (!hit && prevBulletX !== undefined && prevBulletY !== undefined) {
    const prevRelX = prevBulletX - tank.x;
    const prevRelY = prevBulletY - tank.y;
    const prevLocalX = prevRelX * cos + prevRelY * sin;
    const prevLocalY = -prevRelX * sin + prevRelY * cos;
    hit = segmentAABBIntersects(
      prevLocalX, prevLocalY, localX, localY,
      -halfW, -halfH, halfW, halfH,
    );
  }

  if (!hit) return false;

  // Reject hit if a wall stands between bullet and tank center
  if (walls) {
    for (const wall of walls) {
      const { crossed } = bulletCrossesWall(bullet.x, bullet.y, tank.x, tank.y, wall);
      if (crossed) return false;
    }
  }

  return true;
}

// Check whether a tank is allowed to fire a new bullet right now.
// Shared between server and client-side prediction.
export function canFireBullet(now: number, lastFiredAt: number, currentBulletCount: number): boolean {
  return (now - lastFiredAt) >= BULLET_FIRE_COOLDOWN_MS && currentBulletCount < MAX_BULLETS_PER_TANK;
}

export function createBullet(id: string, tank: TankState, walls?: WallSegment[]): BulletState {
  const rad = degreesToRadians(tank.angle);
  const spawnDist = BARREL_LENGTH + TANK_WIDTH / 2; // spawn half a tank length ahead of the tank
  const tipX = tank.x + Math.cos(rad) * spawnDist;
  const tipY = tank.y + Math.sin(rad) * spawnDist;
  const vx = Math.cos(rad) * BULLET_SPEED;
  const vy = Math.sin(rad) * BULLET_SPEED;

  // If the barrel tip is through a wall, reflect the bullet back immediately
  // so it can't pass through — but still fires (allows self-kills).
  if (walls) {
    for (const wall of walls) {
      const { crossed, hitX, hitY } = bulletCrossesWall(tank.x, tank.y, tipX, tipY, wall);
      if (crossed) {
        const bullet: BulletState = { id, ownerId: tank.id, x: tipX, y: tipY, vx, vy, age: 0 };
        return reflectBulletAtWall(bullet, wall, hitX, hitY);
      }
    }
  }

  return {
    id,
    ownerId: tank.id,
    x: tipX,
    y: tipY,
    vx,
    vy,
    age: 0,
  };
}

export function clampTankToMaze(tank: TankState, mazeWidth: number, mazeHeight: number): TankState {
  const { rad, obb } = computeTankOBB(tank.angle);
  // Barrel tip is BARREL_LENGTH past the body edge (TANK_WIDTH/2 from center)
  const barrelTipDist = BARREL_LENGTH + TANK_WIDTH / 2;
  const barrelX = barrelTipDist * Math.cos(rad);
  const barrelY = barrelTipDist * Math.sin(rad);
  const rightExtent  = Math.max(obb, barrelX > 0 ?  barrelX : 0);
  const leftExtent   = Math.max(obb, barrelX < 0 ? -barrelX : 0);
  const bottomExtent = Math.max(obb, barrelY > 0 ?  barrelY : 0);
  const topExtent    = Math.max(obb, barrelY < 0 ? -barrelY : 0);

  const x = Math.max(leftExtent, Math.min(tank.x, mazeWidth - rightExtent));
  const y = Math.max(topExtent,  Math.min(tank.y, mazeHeight - bottomExtent));

  return { ...tank, x, y };
}

// Collide tank (OBB + barrel, asymmetric) against internal maze wall segments.
// prevTank is the position before this tick's movement.
// Returns the corrected tank position and flags indicating which axes were blocked.
export function collideTankWithWalls(
  tank: TankState,
  prevTank: TankState,
  segments: WallSegment[],
): { tank: TankState; hitX: boolean; hitY: boolean } {
  const { rad, cosA, sinA, obb } = computeTankOBB(tank.angle);
  const barrelDirX = Math.cos(rad);
  const barrelDirY = Math.sin(rad);
  // Barrel tip is BARREL_LENGTH past the body edge (TANK_WIDTH/2 from center)
  const barrelTipDist = BARREL_LENGTH + TANK_WIDTH / 2;
  // Pre-compute barrel extents used in range checks (hoisted out of per-wall loop)
  const barrelExtX = Math.max(obb, barrelTipDist * cosA);
  const barrelExtY = Math.max(obb, barrelTipDist * sinA);

  let x = tank.x;
  let y = tank.y;
  let hitX = false;
  let hitY = false;

  for (const wall of segments) {
    if (wall.x1 === wall.x2) {
      // Vertical wall at x = wall.x1
      const wx = wall.x1;
      const minY = Math.min(wall.y1, wall.y2);
      const maxY = Math.max(wall.y1, wall.y2);
      const approachFromLeft = prevTank.x <= wx;
      const barrelFacesWall = approachFromLeft ? barrelDirX > 0 : barrelDirX < 0;
      const rx = barrelFacesWall ? barrelExtX : obb;
      if (y + barrelExtY >= minY && y - barrelExtY <= maxY && Math.abs(x - wx) <= rx) {
        hitX = true;
        x = approachFromLeft ? wx - rx : wx + rx;
        const slideY = y - prevTank.y;
        y = prevTank.y + slideY * (1 - WALL_FRICTION);
      }
    } else if (wall.y1 === wall.y2) {
      // Horizontal wall at y = wall.y1
      const wy = wall.y1;
      const minX = Math.min(wall.x1, wall.x2);
      const maxX = Math.max(wall.x1, wall.x2);
      const approachFromTop = prevTank.y <= wy;
      const barrelFacesWall = approachFromTop ? barrelDirY > 0 : barrelDirY < 0;
      const ry = barrelFacesWall ? barrelExtY : obb;
      if (x + barrelExtX >= minX && x - barrelExtX <= maxX && Math.abs(y - wy) <= ry) {
        hitY = true;
        y = approachFromTop ? wy - ry : wy + ry;
        const slideX = x - prevTank.x;
        x = prevTank.x + slideX * (1 - WALL_FRICTION);
      }
    }
  }

  return { tank: { ...tank, x, y }, hitX, hitY };
}

// Returns whether the bullet path (prevX,prevY)→(nextX,nextY) crosses the wall,
// and if so, the exact hit point. Use this instead of a proximity check.
export function bulletCrossesWall(
  prevX: number,
  prevY: number,
  nextX: number,
  nextY: number,
  wall: WallSegment,
): { crossed: boolean; hitX: number; hitY: number } {
  const miss = { crossed: false, hitX: 0, hitY: 0 };

  if (wall.x1 === wall.x2) {
    const wx = wall.x1;
    const minY = Math.min(wall.y1, wall.y2);
    const maxY = Math.max(wall.y1, wall.y2);
    if (Math.min(prevX, nextX) <= wx && Math.max(prevX, nextX) >= wx) {
      const dx = nextX - prevX;
      if (Math.abs(dx) < 0.001) return miss;
      const t = (wx - prevX) / dx;
      const hitY = prevY + t * (nextY - prevY);
      if (hitY >= minY && hitY <= maxY) return { crossed: true, hitX: wx, hitY };
    }
  } else if (wall.y1 === wall.y2) {
    const wy = wall.y1;
    const minX = Math.min(wall.x1, wall.x2);
    const maxX = Math.max(wall.x1, wall.x2);
    if (Math.min(prevY, nextY) <= wy && Math.max(prevY, nextY) >= wy) {
      const dy = nextY - prevY;
      if (Math.abs(dy) < 0.001) return miss;
      const t = (wy - prevY) / dy;
      const hitX = prevX + t * (nextX - prevX);
      if (hitX >= minX && hitX <= maxX) return { crossed: true, hitX, hitY: wy };
    }
  }

  return miss;
}

// Collect all unique endpoint coordinates from a set of wall segments.
// Used to pre-compute the corner shield point list once per room/match.
export function extractWallEndpoints(segments: WallSegment[]): Vec2[] {
  const seen = new Set<string>();
  const endpoints: Vec2[] = [];
  for (const seg of segments) {
    for (const pt of [{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }]) {
      const key = `${pt.x},${pt.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        endpoints.push(pt);
      }
    }
  }
  return endpoints;
}

// Push the tank away from any wall endpoint it has penetrated into the shield
// zone (OBB radius + CORNER_SHIELD_PADDING). Call this after collideTankWithWalls
// to prevent corner/tip glitches caused by axis-by-axis collision resolution.
export function collideTankWithEndpoints(tank: TankState, endpoints: Vec2[]): TankState {
  const { obb } = computeTankOBB(tank.angle);
  const shieldRadius = obb + CORNER_SHIELD_PADDING;

  let x = tank.x;
  let y = tank.y;

  for (const pt of endpoints) {
    const dx = x - pt.x;
    const dy = y - pt.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < shieldRadius * shieldRadius && distSq > 0) {
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      x = pt.x + nx * shieldRadius;
      y = pt.y + ny * shieldRadius;
    }
  }

  return { ...tank, x, y };
}

// Reflect bullet off a wall, repositioning it at the hit point + epsilon so it
// doesn't re-trigger on the next tick.
export function reflectBulletAtWall(
  bullet: BulletState,
  wall: WallSegment,
  hitX: number,
  hitY: number,
  radius = BULLET_RADIUS,
): BulletState {
  let vx = bullet.vx;
  let vy = bullet.vy;
  let x = hitX;
  let y = hitY;
  const eps = radius + 1;

  if (wall.x1 === wall.x2) {
    vx = -vx;
    x = vx > 0 ? hitX + eps : hitX - eps;
  } else if (wall.y1 === wall.y2) {
    vy = -vy;
    y = vy > 0 ? hitY + eps : hitY - eps;
  }

  return { ...bullet, x, y, vx, vy };
}

// Advance a bullet by one tick: move → lifetime check → single wall bounce.
// Returns null if the bullet has expired.
export function advanceBullet(
  bullet: BulletState,
  dt: number,
  walls: WallSegment[],
): BulletState | null {
  const prevX = bullet.x;
  const prevY = bullet.y;
  const updated = updateBullet(bullet, dt);

  if (updated.age >= BULLET_LIFETIME_SECONDS) return null;

  // Check for wall crossing and reflect, carrying remaining distance through
  for (const wall of walls) {
    const { crossed, hitX, hitY } = bulletCrossesWall(prevX, prevY, updated.x, updated.y, wall);
    if (crossed) {
      const reflected = reflectBulletAtWall(updated, wall, hitX, hitY);
      // Carry remaining travel distance through the reflection.
      // t is the fraction of the path consumed reaching the wall.
      const dx = updated.x - prevX;
      const dy = updated.y - prevY;
      const totalDist = Math.sqrt(dx * dx + dy * dy);
      if (totalDist > 0.001) {
        const hitDx = hitX - prevX;
        const hitDy = hitY - prevY;
        const hitDist = Math.sqrt(hitDx * hitDx + hitDy * hitDy);
        const remainDist = totalDist - hitDist;
        // Move in the reflected direction for the remaining distance
        const speed = Math.sqrt(reflected.vx * reflected.vx + reflected.vy * reflected.vy);
        if (speed > 0) {
          reflected.x += (reflected.vx / speed) * remainDist;
          reflected.y += (reflected.vy / speed) * remainDist;
        }
      }
      return reflected;
    }
  }

  return updated;
}

// Returns the shortest signed rotation from `from` to `to`, in [-180, 180].
export function shortestAngleDelta(to: number, from: number): number {
  let d = ((to - from) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * Cubic Hermite interpolation between two values using surrounding points
 * for tangent estimation. Falls back to linear lerp when neighbors are missing.
 *
 * @param prev  - value at point before `a` (null if unavailable)
 * @param a     - value at start of segment
 * @param b     - value at end of segment
 * @param next  - value at point after `b` (null if unavailable)
 * @param t     - interpolation factor [0, 1] within the a→b segment
 * @param spanPrev - time span from prev to a (ignored if prev is null)
 * @param spanAB   - time span from a to b
 * @param spanNext - time span from b to next (ignored if next is null)
 */
export function hermiteLerp(
  prev: number | null,
  a: number,
  b: number,
  next: number | null,
  t: number,
  spanPrev: number,
  spanAB: number,
  spanNext: number,
): number {
  if (prev === null || next === null) {
    // Linear lerp fallback
    return a + (b - a) * t;
  }

  // Estimate tangents using finite differences, scaled to segment duration
  const slopePrevA = spanPrev > 0 ? (a - prev) / spanPrev : 0;
  const slopeAB = spanAB > 0 ? (b - a) / spanAB : 0;
  const slopeBNext = spanNext > 0 ? (next - b) / spanNext : 0;

  const mA = spanAB * 0.5 * (slopePrevA + slopeAB);
  const mB = spanAB * 0.5 * (slopeAB + slopeBNext);

  // Hermite basis functions
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return h00 * a + h10 * mA + h01 * b + h11 * mB;
}
