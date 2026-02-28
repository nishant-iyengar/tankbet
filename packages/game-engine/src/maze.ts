import { CELL_SIZE } from './constants';
import type { Vec2 } from './physics';

export type Cell = { row: number; col: number };
export type Wall = { from: Cell; to: Cell; axis: 'h' | 'v' };
export type Maze = { cols: number; rows: number; walls: Wall[] };
export type LineSegment = { x1: number; y1: number; x2: number; y2: number };

// Mulberry32 seeded PRNG
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function wallKey(from: Cell, to: Cell): string {
  // Normalize so the key is the same regardless of direction
  if (from.row < to.row || (from.row === to.row && from.col < to.col)) {
    return `${from.row},${from.col}-${to.row},${to.col}`;
  }
  return `${to.row},${to.col}-${from.row},${from.col}`;
}

export function generateMaze(cols: number, rows: number, seed?: number): Maze {
  const random = seed !== undefined ? mulberry32(seed) : Math.random;

  // Build full wall set between adjacent cells
  const allWalls = new Set<string>();
  const wallLookup = new Map<string, Wall>();

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Right neighbor
      if (c + 1 < cols) {
        const from: Cell = { row: r, col: c };
        const to: Cell = { row: r, col: c + 1 };
        const key = wallKey(from, to);
        allWalls.add(key);
        wallLookup.set(key, { from, to, axis: 'v' });
      }
      // Bottom neighbor
      if (r + 1 < rows) {
        const from: Cell = { row: r, col: c };
        const to: Cell = { row: r + 1, col: c };
        const key = wallKey(from, to);
        allWalls.add(key);
        wallLookup.set(key, { from, to, axis: 'h' });
      }
    }
  }

  // Iterative DFS maze generation
  const visited = new Set<string>();
  const stack: Cell[] = [];

  const startRow = Math.floor(random() * rows);
  const startCol = Math.floor(random() * cols);
  const start: Cell = { row: startRow, col: startCol };

  visited.add(cellKey(start.row, start.col));
  stack.push(start);

  // Track last direction to bias toward straight corridors
  let lastDr = 0;
  let lastDc = 0;
  const STRAIGHT_BIAS = 0.6; // probability of continuing straight when possible

  while (stack.length > 0) {
    const current = stack[stack.length - 1];

    // Get unvisited neighbors
    const neighbors: Cell[] = [];
    const directions = [
      { row: current.row - 1, col: current.col },
      { row: current.row + 1, col: current.col },
      { row: current.row, col: current.col - 1 },
      { row: current.row, col: current.col + 1 },
    ];

    for (const next of directions) {
      if (next.row >= 0 && next.row < rows && next.col >= 0 && next.col < cols) {
        if (!visited.has(cellKey(next.row, next.col))) {
          neighbors.push(next);
        }
      }
    }

    if (neighbors.length === 0) {
      stack.pop();
      lastDr = 0;
      lastDc = 0;
      continue;
    }

    // Prefer continuing in the same direction for longer corridors
    let nextCell: Cell;
    const straightNeighbor = (lastDr !== 0 || lastDc !== 0)
      ? neighbors.find(n => n.row - current.row === lastDr && n.col - current.col === lastDc)
      : undefined;

    if (straightNeighbor && random() < STRAIGHT_BIAS) {
      nextCell = straightNeighbor;
    } else {
      nextCell = neighbors[Math.floor(random() * neighbors.length)];
    }

    lastDr = nextCell.row - current.row;
    lastDc = nextCell.col - current.col;
    const key = wallKey(current, nextCell);

    // Remove wall between current and next
    allWalls.delete(key);

    visited.add(cellKey(nextCell.row, nextCell.col));
    stack.push(nextCell);
  }

  // Convert remaining wall keys back to Wall objects
  const walls: Wall[] = [];
  for (const key of allWalls) {
    const wall = wallLookup.get(key);
    if (wall) {
      walls.push(wall);
    }
  }

  return { cols, rows, walls };
}

export function mazeToSegments(maze: Maze): LineSegment[] {
  const segments: LineSegment[] = [];
  const totalWidth = maze.cols * CELL_SIZE;
  const totalHeight = maze.rows * CELL_SIZE;

  // Outer boundary walls
  // Top
  segments.push({ x1: 0, y1: 0, x2: totalWidth, y2: 0 });
  // Bottom
  segments.push({ x1: 0, y1: totalHeight, x2: totalWidth, y2: totalHeight });
  // Left
  segments.push({ x1: 0, y1: 0, x2: 0, y2: totalHeight });
  // Right
  segments.push({ x1: totalWidth, y1: 0, x2: totalWidth, y2: totalHeight });

  // Internal walls
  for (const wall of maze.walls) {
    if (wall.axis === 'v') {
      // Vertical wall between (from.row, from.col) and (from.row, from.col+1)
      // Wall is on the right edge of the 'from' cell
      const x = (wall.from.col + 1) * CELL_SIZE;
      const y = wall.from.row * CELL_SIZE;
      segments.push({ x1: x, y1: y, x2: x, y2: y + CELL_SIZE });
    } else {
      // Horizontal wall between (from.row, from.col) and (from.row+1, from.col)
      // Wall is on the bottom edge of the 'from' cell
      const x = wall.from.col * CELL_SIZE;
      const y = (wall.from.row + 1) * CELL_SIZE;
      segments.push({ x1: x, y1: y, x2: x + CELL_SIZE, y2: y });
    }
  }

  return segments;
}

export function getSpawnPosition(maze: Maze, playerIndex: 0 | 1): Vec2 {
  if (playerIndex === 0) {
    // Top-left area
    return {
      x: CELL_SIZE / 2,
      y: CELL_SIZE / 2,
    };
  }
  // Bottom-right area
  return {
    x: (maze.cols - 1) * CELL_SIZE + CELL_SIZE / 2,
    y: (maze.rows - 1) * CELL_SIZE + CELL_SIZE / 2,
  };
}

export function getRandomSpawn(maze: Maze, occupiedPositions: Vec2[], random: () => number = Math.random): Vec2 {
  const minDistance = CELL_SIZE * 2;
  let bestPosition: Vec2 = { x: CELL_SIZE / 2, y: CELL_SIZE / 2 };
  let bestMinDist = 0;

  // Try random cells, pick the one furthest from all occupied positions
  for (let attempt = 0; attempt < 50; attempt++) {
    const col = Math.floor(random() * maze.cols);
    const row = Math.floor(random() * maze.rows);
    const candidate: Vec2 = {
      x: col * CELL_SIZE + CELL_SIZE / 2,
      y: row * CELL_SIZE + CELL_SIZE / 2,
    };

    let closestDist = Infinity;
    for (const occ of occupiedPositions) {
      const dx = candidate.x - occ.x;
      const dy = candidate.y - occ.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
      }
    }

    if (closestDist >= minDistance) {
      return candidate;
    }

    if (closestDist > bestMinDist) {
      bestMinDist = closestDist;
      bestPosition = candidate;
    }
  }

  return bestPosition;
}
