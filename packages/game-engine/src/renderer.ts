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
  BULLET_LIFETIME_SECONDS,
  BULLET_FADE_SECONDS,
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

export function drawMaze(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, segments: LineSegment[]): void {
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
  ctx.translate(Math.round(tank.x), Math.round(tank.y));
  ctx.rotate(degreesToRadians(tank.angle));

  const hw = TANK_WIDTH / 2;
  const hh = TANK_HEIGHT / 2;
  const treadH = 3;        // height of each tread strip
  const turretR = 4.5;     // turret circle radius
  const bodyR = 3;         // corner rounding

  // Tread strips — darker strips along top and bottom edges
  ctx.fillStyle = darkenColor(color, 0.45);
  ctx.fillRect(-hw, -hh, TANK_WIDTH, treadH);
  ctx.fillRect(-hw, hh - treadH, TANK_WIDTH, treadH);

  // Tank body — rounded rectangle, slightly inset from treads
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-hw + 1, -hh + 1, TANK_WIDTH - 2, TANK_HEIGHT - 2, bodyR);
  ctx.fill();

  // Body outline for definition
  ctx.strokeStyle = darkenColor(color, 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(-hw, -hh, TANK_WIDTH, TANK_HEIGHT, bodyR);
  ctx.stroke();

  // Barrel — extends from center toward the right (angle 0)
  ctx.fillStyle = darkenColor(color, 0.2);
  ctx.fillRect(turretR - 1, -BARREL_WIDTH / 2, BARREL_LENGTH - turretR + 1, BARREL_WIDTH);
  // Barrel outline
  ctx.strokeStyle = darkenColor(color, 0.4);
  ctx.lineWidth = 0.75;
  ctx.strokeRect(turretR - 1, -BARREL_WIDTH / 2, BARREL_LENGTH - turretR + 1, BARREL_WIDTH);

  // Turret circle — sits on top at center
  ctx.fillStyle = darkenColor(color, 0.15);
  ctx.beginPath();
  ctx.arc(0, 0, turretR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = darkenColor(color, 0.4);
  ctx.lineWidth = 0.75;
  ctx.stroke();

  ctx.restore();
}

/** Darken a hex color by a factor (0 = unchanged, 1 = black). */
function darkenColor(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 1 - factor;
  return `rgb(${(r * f) | 0},${(g * f) | 0},${(b * f) | 0})`;
}

export function drawBullet(ctx: CanvasRenderingContext2D, bullet: BulletState): void {
  // Fade out in the last BULLET_FADE_SECONDS of lifetime
  const fadeStart = BULLET_LIFETIME_SECONDS - BULLET_FADE_SECONDS;
  const needsFade = bullet.age > fadeStart;

  if (needsFade) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - (bullet.age - fadeStart) / BULLET_FADE_SECONDS);
  }

  ctx.fillStyle = BULLET_COLOR;
  ctx.beginPath();
  ctx.arc(bullet.x | 0, bullet.y | 0, BULLET_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  if (needsFade) {
    ctx.restore();
  }
}

export interface TrackMark {
  x: number;
  y: number;
  angle: number; // radians
  time: number;  // Date.now() when created
  color: string;
}

const TRACK_WIDTH = 6;   // distance between the two tread marks (from center)
const TRACK_DOT_SIZE = 2; // radius of each tread dot

export function drawTracks(ctx: CanvasRenderingContext2D, tracks: TrackMark[], now: number, lifetimeMs: number): void {
  if (tracks.length === 0) return;

  // Group tracks by color to minimize fillStyle changes
  const byColor = new Map<string, TrackMark[]>();
  for (const track of tracks) {
    const age = now - track.time;
    if (age >= lifetimeMs) continue;
    let group = byColor.get(track.color);
    if (!group) {
      group = [];
      byColor.set(track.color, group);
    }
    group.push(track);
  }

  ctx.save();
  byColor.forEach((group, color) => {
    ctx.fillStyle = color;
    for (const track of group) {
      const age = now - track.time;
      const alpha = Math.max(0, 1 - age / lifetimeMs) * 0.35;
      if (alpha <= 0) continue;

      ctx.globalAlpha = alpha;

      const perpX = -Math.sin(track.angle) * TRACK_WIDTH;
      const perpY = Math.cos(track.angle) * TRACK_WIDTH;

      ctx.beginPath();
      ctx.arc((track.x + perpX) | 0, (track.y + perpY) | 0, TRACK_DOT_SIZE, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc((track.x - perpX) | 0, (track.y - perpY) | 0, TRACK_DOT_SIZE, 0, Math.PI * 2);
      ctx.fill();
    }
  });
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
}
