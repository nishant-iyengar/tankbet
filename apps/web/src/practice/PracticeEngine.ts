import {
  MAZE_COLS,
  MAZE_ROWS,
  CELL_SIZE,
  BULLET_LIFETIME_SECONDS,
  MAX_BULLETS_PER_TANK,
  TANK_COLOR_P1,
} from '@tankbet/game-engine/constants';
import {
  updateTank,
  updateBullet,
  checkBulletTankCollision,
  createBullet,
  clampTankToMaze,
  collideTankWithWalls,
  extractWallEndpoints,
  collideTankWithEndpoints,
  bulletCrossesWall,
  reflectBulletAtWall,
} from '@tankbet/game-engine/physics';
import type { TankState, BulletState, Vec2 } from '@tankbet/game-engine/physics';
import { generateMaze, mazeToSegments, getSpawnPosition } from '@tankbet/game-engine/maze';
import type { Maze, LineSegment } from '@tankbet/game-engine/maze';
import {
  clearCanvas,
  drawMaze,
  drawTank,
  drawBullet,
} from '@tankbet/game-engine/renderer';
import { InputHandler } from '../game/InputHandler';

export class PracticeEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private maze: Maze;
  private segments: LineSegment[];
  private endpoints: Vec2[];
  private tank: TankState;
  private bullets: BulletState[] = [];
  private lastTime = 0;
  private animFrameId: number | null = null;
  private inputHandler: InputHandler;
  private bulletIdCounter = 0;
  private lastFireTime = -Infinity;
  private mazeWidth: number;
  private mazeHeight: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context');
    this.ctx = ctx;
    this.inputHandler = new InputHandler();

    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.segments = mazeToSegments(this.maze);
    this.endpoints = extractWallEndpoints(this.segments);
    this.mazeWidth = MAZE_COLS * CELL_SIZE;
    this.mazeHeight = MAZE_ROWS * CELL_SIZE;

    const spawn = getSpawnPosition(this.maze, 0);
    this.tank = { id: 'practice-player', x: spawn.x, y: spawn.y, angle: 0, speed: 0 };
  }

  start(): void {
    this.inputHandler.attach(0, () => {
      // Input is polled each frame, no need to handle here
    });

    this.lastTime = performance.now();
    this.animFrameId = requestAnimationFrame(this.loop.bind(this));
  }

  private loop(timestamp: number): void {
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05); // Cap at 50ms
    this.lastTime = timestamp;

    this.update(dt);
    this.draw();

    this.animFrameId = requestAnimationFrame(this.loop.bind(this));
  }

  private update(dt: number): void {
    const input = this.inputHandler.getKeys();
    const now = performance.now();

    // Fire cooldown: one bullet per 150ms while key held
    if (input.fire && this.bullets.length < MAX_BULLETS_PER_TANK && now - this.lastFireTime > 150) {
      this.bulletIdCounter++;
      this.bullets.push(createBullet(`bullet-${this.bulletIdCounter}`, this.tank));
      this.lastFireTime = now;
    }

    // Update tank
    const prevTank = { ...this.tank };
    this.tank = updateTank(this.tank, { ...input, fire: false }, dt);
    this.tank = clampTankToMaze(this.tank, this.mazeWidth, this.mazeHeight);
    const { tank: collidedTank } = collideTankWithWalls(this.tank, prevTank, this.segments);
    this.tank = collideTankWithEndpoints(collidedTank, this.endpoints);

    // Update bullets and reflect off walls using segment-crossing test
    this.bullets = this.bullets
      .map((b) => {
        const prevX = b.x;
        const prevY = b.y;
        const advanced = updateBullet(b, dt);
        for (const seg of this.segments) {
          const { crossed, hitX, hitY } = bulletCrossesWall(prevX, prevY, advanced.x, advanced.y, seg);
          if (crossed) {
            return reflectBulletAtWall(advanced, seg, hitX, hitY);
          }
        }
        return advanced;
      })
      .filter((b) => b.age < BULLET_LIFETIME_SECONDS);

    // Bullet-tank collision (self-hit after grace period)
    for (const bullet of this.bullets) {
      if (checkBulletTankCollision(bullet, this.tank)) {
        const spawn = getSpawnPosition(this.maze, 0);
        this.tank = { ...this.tank, x: spawn.x, y: spawn.y, angle: 0, speed: 0 };
        this.bullets = [];
        break;
      }
    }
  }

  private draw(): void {
    clearCanvas(this.ctx, this.canvas.width, this.canvas.height);
    drawMaze(this.ctx, this.segments);
    drawTank(this.ctx, this.tank, TANK_COLOR_P1);

    for (const bullet of this.bullets) {
      drawBullet(this.ctx, bullet);
    }
  }

  regenerateMaze(): void {
    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.segments = mazeToSegments(this.maze);
    this.endpoints = extractWallEndpoints(this.segments);
    const spawn = getSpawnPosition(this.maze, 0);
    this.tank = { id: 'practice-player', x: spawn.x, y: spawn.y, angle: 0, speed: 0 };
    this.bullets = [];
  }

  destroy(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
    this.inputHandler.detach();
  }
}
