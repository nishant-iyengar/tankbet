// packages/game-engine/scripts/parity-trace.ts
//
// Run with: pnpm exec tsx packages/game-engine/scripts/parity-trace.ts
// Outputs: parity_trace.json at repo root (contains maze + wall segments + spawns + tick trace)

import {
  updateTank, clampTankToMaze, collideTankWithWalls,
  collideTankWithEndpoints, extractWallEndpoints,
  createBullet, advanceBullet,
} from '../src/index';
import type { TankState, BulletState, InputState } from '../src/index';
import { generateMaze, mazeToSegments, getSpawnPositions } from '../src/index';
import { mulberry32 } from '../src/maze';
import {
  CELL_SIZE, MAZE_COLS, MAZE_ROWS,
  BULLET_FIRE_COOLDOWN_MS, MAX_BULLETS_PER_TANK,
  SERVER_TICK_HZ,
} from '../src/constants';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CANVAS_W = MAZE_COLS * CELL_SIZE;
const CANVAS_H = MAZE_ROWS * CELL_SIZE;
const DT = 1 / SERVER_TICK_HZ;
const TOTAL_TICKS = 1000;

const MAZE_SEED = 42;

// Fixed action sequence: alternate forward, forward+right, fire
const ACTION_SEQUENCE: InputState[] = [
  { up: true,  down: false, left: false, right: false, fire: false },  // forward
  { up: true,  down: false, left: false, right: true,  fire: false },  // forward + right
  { up: false, down: false, left: false, right: false, fire: true  },  // fire
];

// Generate maze with fixed seed
const maze = generateMaze(MAZE_COLS, MAZE_ROWS, MAZE_SEED);
const walls = mazeToSegments(maze);
const endpoints = extractWallEndpoints(walls);
const spawnRng = mulberry32(MAZE_SEED);
const spawns = getSpawnPositions(maze, spawnRng);

let tank: TankState = {
  id: 'p0', x: spawns[0].x, y: spawns[0].y, angle: 0, speed: 0,
};
let bullets: BulletState[] = [];
let lastFiredAt = -Infinity;
let bulletId = 0;

interface TickRecord {
  tick: number;
  x: number;
  y: number;
  angle: number;
  bulletCount: number;
  bulletPositions: Array<{ x: number; y: number; vx: number; vy: number }>;
}

const trace: TickRecord[] = [];

for (let tick = 0; tick < TOTAL_TICKS; tick++) {
  const action = ACTION_SEQUENCE[tick % ACTION_SEQUENCE.length]!;
  const prevTank = { ...tank };

  // Update tank
  tank = updateTank(tank, action, DT);
  tank = clampTankToMaze(tank, CANVAS_W, CANVAS_H);
  const collision = collideTankWithWalls(tank, prevTank, walls);
  tank = collision.tank;
  tank = collideTankWithEndpoints(tank, endpoints);

  // Fire bullet
  const now = tick * (1000 / SERVER_TICK_HZ);  // ms
  if (action.fire && (now - lastFiredAt) >= BULLET_FIRE_COOLDOWN_MS
      && bullets.length < MAX_BULLETS_PER_TANK) {
    bullets.push(createBullet(`b${bulletId++}`, tank, walls));
    lastFiredAt = now;
  }

  // Update bullets
  const newBullets: BulletState[] = [];
  for (const b of bullets) {
    const updated = advanceBullet(b, DT, walls);
    if (updated) newBullets.push(updated);
  }
  bullets = newBullets;

  // Record state
  trace.push({
    tick,
    x: Math.round(tank.x * 10000) / 10000,
    y: Math.round(tank.y * 10000) / 10000,
    angle: Math.round(tank.angle * 10000) / 10000,
    bulletCount: bullets.length,
    bulletPositions: bullets.map(b => ({
      x: Math.round(b.x * 10000) / 10000,
      y: Math.round(b.y * 10000) / 10000,
      vx: Math.round(b.vx * 10000) / 10000,
      vy: Math.round(b.vy * 10000) / 10000,
    })),
  });
}

// Write maze geometry + spawns + trace in a single file.
// Python loads the maze from here instead of generating its own,
// eliminating RNG algorithm mismatch (mulberry32 vs PCG64).
const output = {
  maze,
  wallSegments: walls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })),
  endpoints: endpoints.map(e => ({ x: e.x, y: e.y })),
  spawns: spawns.map(s => ({ x: s.x, y: s.y })),
  trace,
};

const outPath = resolve(__dirname, '../../../parity_trace.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Wrote maze + ${trace.length} ticks to ${outPath}`);
console.log(`Final tank: (${tank.x.toFixed(4)}, ${tank.y.toFixed(4)}) angle=${tank.angle.toFixed(4)}`);
