import { describe, it, expect } from 'vitest';
import { mulberry32, generateMaze, getSpawnPositions } from '../src/maze';
import { CELL_SIZE } from '../src/constants';

describe('mulberry32', () => {
  it('produces identical sequence for the same seed', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('always produces values in [0, 1)', () => {
    const rng = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });
});

describe('generateMaze', () => {
  it('returns valid structure with correct cols/rows and all cells reachable', () => {
    const maze = generateMaze(5, 4, 99);
    expect(maze.cols).toBe(5);
    expect(maze.rows).toBe(4);

    // Verify connectivity via BFS: build adjacency from missing walls
    // First, collect all walls that exist
    const wallSet = new Set<string>();
    for (const w of maze.walls) {
      wallSet.add(`${w.from.row},${w.from.col}-${w.to.row},${w.to.col}`);
      wallSet.add(`${w.to.row},${w.to.col}-${w.from.row},${w.from.col}`);
    }

    const visited = new Set<string>();
    const queue = ['0,0'];
    visited.add('0,0');

    while (queue.length > 0) {
      const key = queue.shift()!;
      const [r, c] = key.split(',').map(Number);
      const neighbors = [
        [r! - 1, c],
        [r! + 1, c],
        [r, c! - 1],
        [r, c! + 1],
      ];
      for (const [nr, nc] of neighbors) {
        if (nr! < 0 || nr! >= maze.rows || nc! < 0 || nc! >= maze.cols) continue;
        const nKey = `${nr},${nc}`;
        if (visited.has(nKey)) continue;
        // Check if wall exists between current and neighbor
        const wKey = `${r},${c}-${nr},${nc}`;
        if (!wallSet.has(wKey)) {
          visited.add(nKey);
          queue.push(nKey);
        }
      }
    }

    expect(visited.size).toBe(5 * 4);
  });

  it('produces identical maze for the same seed', () => {
    const maze1 = generateMaze(6, 5, 777);
    const maze2 = generateMaze(6, 5, 777);

    const toKey = (w: { from: { row: number; col: number }; to: { row: number; col: number }; axis: string }) =>
      `${w.from.row},${w.from.col}-${w.to.row},${w.to.col}-${w.axis}`;

    const set1 = new Set(maze1.walls.map(toKey));
    const set2 = new Set(maze2.walls.map(toKey));

    expect(set1.size).toBe(set2.size);
    for (const k of set1) {
      expect(set2.has(k)).toBe(true);
    }
  });
});

describe('getSpawnPositions', () => {
  it('returns two spawn points at least 10% of diagonal apart', () => {
    const maze = generateMaze(9, 6, 42);
    const rng = mulberry32(42);
    const [p1, p2] = getSpawnPositions(maze, rng);

    const totalWidth = maze.cols * CELL_SIZE;
    const totalHeight = maze.rows * CELL_SIZE;
    const diagonal = Math.sqrt(totalWidth * totalWidth + totalHeight * totalHeight);
    const minDistance = diagonal * 0.10;

    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    expect(dist).toBeGreaterThanOrEqual(minDistance);
  });
});
