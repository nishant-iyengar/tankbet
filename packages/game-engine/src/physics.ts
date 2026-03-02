import {
  TANK_SPEED,
  TANK_ROTATION_SPEED,
  BULLET_SPEED,
  BARREL_LENGTH,
  TANK_WIDTH,
  TANK_HEIGHT,
  BULLET_RADIUS,
  BULLET_LIFETIME_SECONDS,
  WALL_FRICTION,
  CORNER_SHIELD_PADDING,
  BULLET_FIRE_COOLDOWN_MS,
  MAX_BULLETS_PER_TANK,
  MISSILE_SPEED,
  MISSILE_HOMING_DELAY_S,
  MISSILE_TURN_SPEED_DEG,
  MISSILE_WALL_AVOID_RADIUS,
  MISSILE_WALL_AVOID_STRENGTH,
  MISSILE_WALL_AVOID_TURN_DEG,
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
    speed = -TANK_SPEED * 0.85;
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

export function checkBulletTankCollision(bullet: BulletState, tank: TankState): boolean {
  // Circle (bullet) vs AABB (tank) collision
  const halfW = TANK_WIDTH / 2;
  const halfH = TANK_HEIGHT / 2;

  const tankLeft = tank.x - halfW;
  const tankRight = tank.x + halfW;
  const tankTop = tank.y - halfH;
  const tankBottom = tank.y + halfH;

  // Find closest point on AABB to bullet center
  const closestX = Math.max(tankLeft, Math.min(bullet.x, tankRight));
  const closestY = Math.max(tankTop, Math.min(bullet.y, tankBottom));

  const dx = bullet.x - closestX;
  const dy = bullet.y - closestY;
  const distSquared = dx * dx + dy * dy;

  return distSquared <= BULLET_RADIUS * BULLET_RADIUS;
}

// Check whether a tank is allowed to fire a new bullet right now.
// Shared between server and client-side prediction.
export function canFireBullet(now: number, lastFiredAt: number, currentBulletCount: number): boolean {
  return (now - lastFiredAt) >= BULLET_FIRE_COOLDOWN_MS && currentBulletCount < MAX_BULLETS_PER_TANK;
}

export function createBullet(id: string, tank: TankState): BulletState {
  const rad = degreesToRadians(tank.angle);
  const spawnDist = BARREL_LENGTH + TANK_WIDTH / 2; // spawn half a tank length ahead of the tank
  const tipX = tank.x + Math.cos(rad) * spawnDist;
  const tipY = tank.y + Math.sin(rad) * spawnDist;

  return {
    id,
    ownerId: tank.id,
    x: tipX,
    y: tipY,
    vx: Math.cos(rad) * BULLET_SPEED,
    vy: Math.sin(rad) * BULLET_SPEED,
    age: 0,
  };
}

export function clampTankToMaze(tank: TankState, mazeWidth: number, mazeHeight: number): TankState {
  const { rad, obb } = computeTankOBB(tank.angle);
  const barrelX = BARREL_LENGTH * Math.cos(rad);
  const barrelY = BARREL_LENGTH * Math.sin(rad);
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
  // Pre-compute barrel extents used in range checks (hoisted out of per-wall loop)
  const barrelExtX = Math.max(obb, BARREL_LENGTH * cosA);
  const barrelExtY = Math.max(obb, BARREL_LENGTH * sinA);

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

// Generic circle vs AABB tank collision. Callers that need a non-BULLET_RADIUS
// check (e.g. missiles) use this instead of checkBulletTankCollision.
export function checkCircleTankCollision(
  x: number,
  y: number,
  radius: number,
  tank: TankState,
): boolean {
  const halfW = TANK_WIDTH / 2;
  const halfH = TANK_HEIGHT / 2;
  const closestX = Math.max(tank.x - halfW, Math.min(x, tank.x + halfW));
  const closestY = Math.max(tank.y - halfH, Math.min(y, tank.y + halfH));
  const dx = x - closestX;
  const dy = y - closestY;
  return dx * dx + dy * dy <= radius * radius;
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

  let reflected = updated;
  for (const wall of walls) {
    const { crossed, hitX, hitY } = bulletCrossesWall(prevX, prevY, reflected.x, reflected.y, wall);
    if (crossed) {
      reflected = reflectBulletAtWall(reflected, wall, hitX, hitY);
      break; // max 1 bounce per tick
    }
  }

  return reflected;
}

// ---------------------------------------------------------------------------
// Targeting missile
// ---------------------------------------------------------------------------

export type MissileState = {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  vx: number; // always MISSILE_SPEED magnitude
  vy: number;
  age: number;
  initialTargetId: string; // enemy tank's id for the first MISSILE_HOMING_DELAY_S seconds
  // homingActive is intentionally omitted — derived as age >= MISSILE_HOMING_DELAY_S wherever needed
};

export function createMissile(id: string, tank: TankState, enemyId: string): MissileState {
  const rad = degreesToRadians(tank.angle);
  const spawnDist = BARREL_LENGTH + TANK_WIDTH / 2; // spawn half a tank length ahead of the tank
  const tipX = tank.x + Math.cos(rad) * spawnDist;
  const tipY = tank.y + Math.sin(rad) * spawnDist;
  return {
    id,
    ownerId: tank.id,
    x: tipX,
    y: tipY,
    vx: Math.cos(rad) * MISSILE_SPEED,
    vy: Math.sin(rad) * MISSILE_SPEED,
    age: 0,
    initialTargetId: enemyId,
  };
}

// Returns the closest point on segment (ax,ay)→(bx,by) to point (px,py).
function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: ax, y: ay };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return { x: ax + t * dx, y: ay + t * dy };
}

// Steer the missile toward its target (dumb, 90°/s) while smartly avoiding walls
// (potential-field repulsion, up to 300°/s when walls are close).
// Missiles do NOT bounce — wall contact is handled by the caller (destroy on crossing).
export function updateMissile(
  missile: MissileState,
  tanks: TankState[],
  walls: WallSegment[],
  dt: number,
): MissileState {
  const newAge = missile.age + dt;

  // --- Determine homing target ---
  let targetTank: TankState | undefined;
  if (newAge < MISSILE_HOMING_DELAY_S) {
    targetTank = tanks.find((t) => t.id === missile.initialTargetId);
  } else {
    let minDistSq = Infinity;
    for (const t of tanks) {
      const dx = t.x - missile.x;
      const dy = t.y - missile.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < minDistSq) {
        minDistSq = distSq;
        targetTank = t;
      }
    }
  }

  // --- Homing vector (normalized, zero if no target) ---
  let homingX = 0;
  let homingY = 0;
  if (targetTank) {
    const dx = targetTank.x - missile.x;
    const dy = targetTank.y - missile.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) { homingX = dx / dist; homingY = dy / dist; }
  }

  // --- Wall avoidance: potential-field repulsion from nearby wall segments ---
  let avoidX = 0;
  let avoidY = 0;
  let maxRepulsion = 0; // [0, 1] — how urgently walls need avoiding right now
  for (const wall of walls) {
    const cp = closestPointOnSegment(missile.x, missile.y, wall.x1, wall.y1, wall.x2, wall.y2);
    const dx = missile.x - cp.x;
    const dy = missile.y - cp.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < MISSILE_WALL_AVOID_RADIUS && dist > 0) {
      const t = 1 - dist / MISSILE_WALL_AVOID_RADIUS;
      const weight = t * t; // quadratic falloff
      avoidX += (dx / dist) * weight;
      avoidY += (dy / dist) * weight;
      if (weight > maxRepulsion) maxRepulsion = weight;
    }
  }

  // --- Blend homing + avoidance into a desired direction ---
  const currentAngleDeg = radiansToDegrees(Math.atan2(missile.vy, missile.vx));
  const blendX = homingX + avoidX * MISSILE_WALL_AVOID_STRENGTH;
  const blendY = homingY + avoidY * MISSILE_WALL_AVOID_STRENGTH;
  let desiredAngleDeg = currentAngleDeg;
  if (blendX !== 0 || blendY !== 0) {
    desiredAngleDeg = radiansToDegrees(Math.atan2(blendY, blendX));
  }

  // --- Turn rate: scales from dumb (90°/s) up to fast (300°/s) near walls ---
  const effectiveTurnRate =
    MISSILE_TURN_SPEED_DEG +
    (MISSILE_WALL_AVOID_TURN_DEG - MISSILE_TURN_SPEED_DEG) * maxRepulsion;
  const maxTurnDeg = effectiveTurnRate * dt;
  let delta = shortestAngleDelta(desiredAngleDeg, currentAngleDeg);
  if (Math.abs(delta) > maxTurnDeg) delta = Math.sign(delta) * maxTurnDeg;

  const newAngleDeg = currentAngleDeg + delta;
  const newRad = degreesToRadians(newAngleDeg);

  return {
    ...missile,
    x: missile.x + Math.cos(newRad) * MISSILE_SPEED * dt,
    y: missile.y + Math.sin(newRad) * MISSILE_SPEED * dt,
    vx: Math.cos(newRad) * MISSILE_SPEED,
    vy: Math.sin(newRad) * MISSILE_SPEED,
    age: newAge,
  };
}

// Returns the shortest signed rotation from `from` to `to`, in [-180, 180].
export function shortestAngleDelta(to: number, from: number): number {
  let d = ((to - from) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}
