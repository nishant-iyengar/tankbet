import { generateMaze, mazeToSegments, getSpawnPositions, extractWallEndpoints } from '../src/index';
import type { Maze, Wall, MazeOptions } from '../src/index';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NUM_MAZES = 10_000;
const MAZE_COLS = 9;
const MAZE_ROWS = 6;
const CELL_SIZE = 120;
const ARENA_W = MAZE_COLS * CELL_SIZE;
const ARENA_H = MAZE_ROWS * CELL_SIZE;

interface WallExport {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  axis: 'h' | 'v';
}

interface MazeExport {
  seed: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  walls: WallExport[];
  segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  endpoints: Array<{ x: number; y: number }>;
  spawns: Array<{ x: number; y: number }>;
}

interface TierConfig {
  name: string;
  straightBias: number;
  wallRemovalPct: number;
}

const TIERS: TierConfig[] = [
  { name: 'easy', straightBias: 0.95, wallRemovalPct: 0.50 },
  { name: 'medium', straightBias: 0.80, wallRemovalPct: 0.20 },
  { name: 'hard', straightBias: 0.50, wallRemovalPct: 0.05 },
];

const outDir = resolve(__dirname, '../../../training/data');
mkdirSync(outDir, { recursive: true });

for (const tier of TIERS) {
  const mazes: MazeExport[] = [];
  const options: MazeOptions = {
    straightBias: tier.straightBias,
    wallRemovalPct: tier.wallRemovalPct,
  };

  for (let seed = 0; seed < NUM_MAZES; seed++) {
    const maze: Maze = generateMaze(MAZE_COLS, MAZE_ROWS, seed, options);
    const segments = mazeToSegments(maze);
    const endpoints = extractWallEndpoints(segments);
    const [spawn1, spawn2] = getSpawnPositions(maze);

    mazes.push({
      seed,
      width: ARENA_W,
      height: ARENA_H,
      cols: MAZE_COLS,
      rows: MAZE_ROWS,
      walls: maze.walls.map((w: Wall) => ({
        fromRow: w.from.row,
        fromCol: w.from.col,
        toRow: w.to.row,
        toCol: w.to.col,
        axis: w.axis,
      })),
      segments: segments.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
      endpoints: endpoints.map((e) => ({ x: e.x, y: e.y })),
      spawns: [
        { x: spawn1.x, y: spawn1.y },
        { x: spawn2.x, y: spawn2.y },
      ],
    });

    if ((seed + 1) % 1000 === 0) {
      console.log(`Generated ${seed + 1}/${NUM_MAZES} ${tier.name} mazes`);
    }
  }

  const outPath = resolve(outDir, `mazes_${tier.name}.json`);
  writeFileSync(outPath, JSON.stringify(mazes));
  console.log(`Wrote ${mazes.length} ${tier.name} mazes to ${outPath}`);
}

// Also write mazes.json as backward compatibility (medium tier)
const mediumMazes: MazeExport[] = [];
const mediumOptions: MazeOptions = {
  straightBias: 0.80,
  wallRemovalPct: 0.20,
};

for (let seed = 0; seed < NUM_MAZES; seed++) {
  const maze: Maze = generateMaze(MAZE_COLS, MAZE_ROWS, seed, mediumOptions);
  const segments = mazeToSegments(maze);
  const endpoints = extractWallEndpoints(segments);
  const [spawn1, spawn2] = getSpawnPositions(maze);

  mediumMazes.push({
    seed,
    width: ARENA_W,
    height: ARENA_H,
    cols: MAZE_COLS,
    rows: MAZE_ROWS,
    walls: maze.walls.map((w: Wall) => ({
      fromRow: w.from.row,
      fromCol: w.from.col,
      toRow: w.to.row,
      toCol: w.to.col,
      axis: w.axis,
    })),
    segments: segments.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
    endpoints: endpoints.map((e) => ({ x: e.x, y: e.y })),
    spawns: [
      { x: spawn1.x, y: spawn1.y },
      { x: spawn2.x, y: spawn2.y },
    ],
  });

  if ((seed + 1) % 1000 === 0) {
    console.log(`Generated ${seed + 1}/${NUM_MAZES} medium mazes (backward compat)`);
  }
}

const compatPath = resolve(outDir, 'mazes.json');
writeFileSync(compatPath, JSON.stringify(mediumMazes));
console.log(`Wrote ${mediumMazes.length} medium mazes to ${compatPath} (backward compatibility)`);
