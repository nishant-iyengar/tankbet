import { describe, it, expect } from 'vitest';
import {
  degreesToRadians,
  radiansToDegrees,
  updateTank,
  updateBullet,
  reflectBullet,
  canFireBullet,
  checkBulletTankCollision,
  shortestAngleDelta,
} from '../src/physics';
import type { InputState, TankState, BulletState, WallSegment } from '../src/physics';
import { TANK_SPEED, TANK_ROTATION_SPEED, BULLET_FIRE_COOLDOWN_MS, MAX_BULLETS_PER_TANK } from '../src/constants';

const noInput: InputState = { up: false, down: false, left: false, right: false, fire: false };

function makeTank(overrides: Partial<TankState> = {}): TankState {
  return { id: 'tank1', x: 100, y: 100, angle: 0, speed: 0, ...overrides };
}

function makeBullet(overrides: Partial<BulletState> = {}): BulletState {
  return { id: 'b1', ownerId: 'tank1', x: 50, y: 50, vx: 100, vy: 0, age: 0, ...overrides };
}

describe('degreesToRadians / radiansToDegrees', () => {
  it('round-trips correctly for key angles', () => {
    for (const deg of [0, 90, 180, 360]) {
      expect(radiansToDegrees(degreesToRadians(deg))).toBeCloseTo(deg);
    }
    expect(degreesToRadians(180)).toBeCloseTo(Math.PI);
    expect(degreesToRadians(90)).toBeCloseTo(Math.PI / 2);
  });
});

describe('updateTank', () => {
  it('moves forward in the direction of its angle at TANK_SPEED', () => {
    const tank = makeTank({ angle: 0 });
    const input: InputState = { ...noInput, up: true };
    const dt = 1;
    const result = updateTank(tank, input, dt);
    expect(result.x).toBeCloseTo(tank.x + TANK_SPEED);
    expect(result.y).toBeCloseTo(tank.y);
  });

  it('rotates angle when left/right pressed', () => {
    const tank = makeTank({ angle: 0 });
    const dt = 0.1;

    const leftResult = updateTank(tank, { ...noInput, left: true }, dt);
    expect(leftResult.angle).toBeCloseTo(360 - TANK_ROTATION_SPEED * dt);

    const rightResult = updateTank(tank, { ...noInput, right: true }, dt);
    expect(rightResult.angle).toBeCloseTo(TANK_ROTATION_SPEED * dt);
  });

  it('stays stationary with no input', () => {
    const tank = makeTank({ angle: 45 });
    const result = updateTank(tank, noInput, 1);
    expect(result.x).toBeCloseTo(tank.x);
    expect(result.y).toBeCloseTo(tank.y);
    expect(result.angle).toBe(45);
    expect(result.speed).toBe(0);
  });
});

describe('updateBullet', () => {
  it('advances position by velocity * dt and increments age', () => {
    const bullet = makeBullet({ x: 10, y: 20, vx: 100, vy: -50, age: 1 });
    const dt = 0.5;
    const result = updateBullet(bullet, dt);
    expect(result.x).toBeCloseTo(10 + 100 * 0.5);
    expect(result.y).toBeCloseTo(20 + -50 * 0.5);
    expect(result.age).toBeCloseTo(1.5);
  });
});

describe('reflectBullet', () => {
  it('flips vy for horizontal wall', () => {
    const bullet = makeBullet({ vx: 100, vy: 50 });
    const hWall: WallSegment = { x1: 0, y1: 100, x2: 200, y2: 100 };
    const result = reflectBullet(bullet, hWall);
    expect(result.vx).toBe(100);
    expect(result.vy).toBe(-50);
  });

  it('flips vx for vertical wall', () => {
    const bullet = makeBullet({ vx: 100, vy: 50 });
    const vWall: WallSegment = { x1: 200, y1: 0, x2: 200, y2: 200 };
    const result = reflectBullet(bullet, vWall);
    expect(result.vx).toBe(-100);
    expect(result.vy).toBe(50);
  });
});

describe('canFireBullet', () => {
  it('respects cooldown timer and max bullet count', () => {
    // Can fire: enough time passed and under max
    expect(canFireBullet(1000, 0, 0)).toBe(true);

    // Cannot fire: cooldown not elapsed
    expect(canFireBullet(100, 0, 0)).toBe(false);
    expect(canFireBullet(BULLET_FIRE_COOLDOWN_MS - 1, 0, 0)).toBe(false);

    // Can fire: exactly at cooldown boundary
    expect(canFireBullet(BULLET_FIRE_COOLDOWN_MS, 0, 0)).toBe(true);

    // Cannot fire: at max bullets
    expect(canFireBullet(1000, 0, MAX_BULLETS_PER_TANK)).toBe(false);
  });
});

describe('checkBulletTankCollision (circleAABBOverlap)', () => {
  it('detects collision when bullet overlaps tank body', () => {
    const tank = makeTank({ x: 100, y: 100, angle: 0 });
    const bullet = makeBullet({ x: 105, y: 100 });
    expect(checkBulletTankCollision(bullet, tank)).toBe(true);
  });

  it('returns false when bullet is far from tank', () => {
    const tank = makeTank({ x: 100, y: 100, angle: 0 });
    const bullet = makeBullet({ x: 300, y: 300 });
    expect(checkBulletTankCollision(bullet, tank)).toBe(false);
  });
});

describe('shortestAngleDelta', () => {
  it('returns shortest signed rotation', () => {
    expect(shortestAngleDelta(10, 350)).toBeCloseTo(20);
    expect(shortestAngleDelta(350, 10)).toBeCloseTo(-20);
    expect(shortestAngleDelta(180, 0)).toBeCloseTo(180);
    expect(shortestAngleDelta(0, 0)).toBeCloseTo(0);
    expect(shortestAngleDelta(90, 0)).toBeCloseTo(90);
    expect(shortestAngleDelta(0, 90)).toBeCloseTo(-90);
  });
});
