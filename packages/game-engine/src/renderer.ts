import {
  TANK_WIDTH,
  TANK_HEIGHT,
  BARREL_LENGTH,
  BULLET_RADIUS,
  BARREL_WIDTH,
  WALL_LINE_WIDTH,
  COUNTDOWN_OVERLAY_ALPHA,
  HUD_PADDING,
  TANK_COLOR_P1,
  TANK_COLOR_P2,
} from './constants';
import type { TankState, BulletState } from './physics';
import { degreesToRadians } from './physics';
import type { LineSegment } from './maze';

const BACKGROUND_COLOR = '#1a1a2e';
const WALL_COLOR = '#ffffff';
const BULLET_COLOR = '#ffd700';
const HUD_FONT = '14px monospace';
const COUNTDOWN_FONT = 'bold 96px monospace';

export function clearCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, height);
}

export function drawMaze(ctx: CanvasRenderingContext2D, segments: LineSegment[]): void {
  ctx.strokeStyle = WALL_COLOR;
  ctx.lineWidth = WALL_LINE_WIDTH;
  ctx.beginPath();
  for (const seg of segments) {
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
  }
  ctx.stroke();
}

export function drawTank(ctx: CanvasRenderingContext2D, tank: TankState, color: string): void {
  ctx.save();
  ctx.translate(tank.x, tank.y);
  ctx.rotate(degreesToRadians(tank.angle));

  // Tank body — centered on origin
  ctx.fillStyle = color;
  ctx.fillRect(-TANK_WIDTH / 2, -TANK_HEIGHT / 2, TANK_WIDTH, TANK_HEIGHT);

  // Barrel — extends from center toward the right (angle 0)
  ctx.fillStyle = color;
  ctx.fillRect(0, -BARREL_WIDTH / 2, BARREL_LENGTH, BARREL_WIDTH);

  ctx.restore();
}

export function drawBullet(ctx: CanvasRenderingContext2D, bullet: BulletState): void {
  ctx.save();
  ctx.fillStyle = BULLET_COLOR;
  ctx.beginPath();
  ctx.arc(bullet.x, bullet.y, BULLET_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawCountdown(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  count: number,
): void {
  // Semi-transparent overlay
  ctx.fillStyle = `rgba(0, 0, 0, ${COUNTDOWN_OVERLAY_ALPHA})`;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Large centered countdown number
  ctx.fillStyle = '#ffffff';
  ctx.font = COUNTDOWN_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const text = count > 0 ? String(count) : 'GO!';
  ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);
}

export const EXPLOSION_DURATION_MS = 650;
const EXPLOSION_PARTICLE_COUNT = 12;
const EXPLOSION_MAX_RADIUS = 28;

export function drawExplosion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  elapsedMs: number,
): void {
  const t = Math.min(elapsedMs / EXPLOSION_DURATION_MS, 1); // 0 → 1
  const alpha = 1 - t;

  ctx.save();

  // Central white flash (first 30% of duration only)
  if (t < 0.3) {
    const flashT = t / 0.3;
    ctx.globalAlpha = (1 - flashT) * 0.9;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 14 * flashT, 0, Math.PI * 2);
    ctx.fill();
  }

  // Expanding shockwave ring
  ctx.globalAlpha = alpha * 0.7;
  ctx.strokeStyle = '#fb923c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, EXPLOSION_MAX_RADIUS * t, 0, Math.PI * 2);
  ctx.stroke();

  // Radiating particles — vary speed so they spread at different rates
  for (let i = 0; i < EXPLOSION_PARTICLE_COUNT; i++) {
    const angle = (i / EXPLOSION_PARTICLE_COUNT) * Math.PI * 2;
    const speedFactor = 0.5 + (i % 3) * 0.25; // 0.5 / 0.75 / 1.0
    const dist = EXPLOSION_MAX_RADIUS * speedFactor * t;
    const px = x + Math.cos(angle) * dist;
    const py = y + Math.sin(angle) * dist;
    const radius = 2.5 * (1 - t * 0.6);

    // Color: white → yellow → orange as t increases
    const color = t < 0.25 ? '#ffffff' : t < 0.55 ? '#fbbf24' : '#f97316';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

export function drawHUD(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  player1Name: string,
  player2Name: string,
  player1Lives: number,
  player2Lives: number,
  betAmountCents: number,
): void {
  ctx.font = HUD_FONT;
  ctx.textBaseline = 'top';

  // Player 1 — top left
  if (player1Name) {
    ctx.fillStyle = TANK_COLOR_P1;
    ctx.textAlign = 'left';
    const p1Hearts = '\u2665'.repeat(player1Lives);
    const p1Text = `${player1Name}  ${p1Hearts}`;
    ctx.fillText(p1Text, HUD_PADDING, HUD_PADDING);
  }

  // Player 2 — top right
  if (player2Name) {
    ctx.font = HUD_FONT;
    ctx.fillStyle = TANK_COLOR_P2;
    ctx.textAlign = 'right';
    const p2Hearts = '\u2665'.repeat(player2Lives);
    const p2Text = `${p2Hearts}  ${player2Name}`;
    ctx.fillText(p2Text, canvasWidth - HUD_PADDING, HUD_PADDING);
  }

  // Bet amount — bottom center
  if (betAmountCents > 0) {
    ctx.font = HUD_FONT;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const dollars = (betAmountCents / 100).toFixed(2);
    ctx.fillText(`Playing for $${dollars}`, canvasWidth / 2, canvasHeight - HUD_PADDING);
  }
}
