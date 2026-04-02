import {
  TANK_WIDTH,
  TANK_HEIGHT,
  BARREL_LENGTH,
  BULLET_LENGTH,
  BULLET_WIDTH,
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
const BULLET_OUTLINE_DARKEN = 0.35;
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

export function drawBullet(ctx: CanvasRenderingContext2D, bullet: BulletState, color: string): void {
  // Fade out in the last BULLET_FADE_SECONDS of lifetime
  const fadeStart = BULLET_LIFETIME_SECONDS - BULLET_FADE_SECONDS;
  const needsFade = bullet.age > fadeStart;

  ctx.save();

  if (needsFade) {
    ctx.globalAlpha = Math.max(0, 1 - (bullet.age - fadeStart) / BULLET_FADE_SECONDS);
  }

  // Orient bullet in direction of travel
  const angle = Math.atan2(bullet.vy, bullet.vx);
  ctx.translate(bullet.x | 0, bullet.y | 0);
  ctx.rotate(angle);

  const halfLen = BULLET_LENGTH / 2;
  const halfW = BULLET_WIDTH / 2;
  const tipLen = 3; // length of the pointed tip

  // Bullet shape: flat rear, rectangular body, pointed tip
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-halfLen, -halfW);              // rear top
  ctx.lineTo(halfLen - tipLen, -halfW);      // body top → tip base
  ctx.lineTo(halfLen, 0);                    // tip point
  ctx.lineTo(halfLen - tipLen, halfW);       // tip base → body bottom
  ctx.lineTo(-halfLen, halfW);               // rear bottom
  ctx.closePath();
  ctx.fill();

  // Subtle darker outline
  ctx.strokeStyle = darkenColor(color, BULLET_OUTLINE_DARKEN);
  ctx.lineWidth = 0.5;
  ctx.stroke();

  ctx.restore();
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

export const EXPLOSION_DURATION_MS = 750;
const EXPLOSION_MAX_RADIUS = 32;

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function drawExplosion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  elapsedMs: number,
  tankColor: string,
): void {
  const t = Math.min(elapsedMs / EXPLOSION_DURATION_MS, 1);
  const { r, g, b } = hexToRgb(tankColor);
  const rand = seededRandom(Math.round(x * 1000 + y));

  ctx.save();

  // Core flash — white center fading into tank color
  if (t < 0.25) {
    const flashT = t / 0.25;
    const flashRadius = 18 * flashT;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, flashRadius);
    gradient.addColorStop(0, `rgba(255, 255, 255, ${(1 - flashT) * 0.95})`);
    gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${(1 - flashT) * 0.7})`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, flashRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Expanding fireball glow
  if (t < 0.7) {
    const glowT = Math.min(t / 0.7, 1);
    const glowRadius = EXPLOSION_MAX_RADIUS * 0.8 * glowT;
    const glowAlpha = (1 - glowT) * 0.5;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glowAlpha})`);
    gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${glowAlpha * 0.3})`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Shockwave ring in tank color
  const ringAlpha = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
  ctx.globalAlpha = ringAlpha * 0.6;
  ctx.strokeStyle = tankColor;
  ctx.lineWidth = 2.5 * (1 - t * 0.6);
  ctx.beginPath();
  ctx.arc(x, y, EXPLOSION_MAX_RADIUS * t, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Debris chunks — larger pieces that fly outward with ease-out
  const chunkCount = 8;
  for (let i = 0; i < chunkCount; i++) {
    const baseAngle = (i / chunkCount) * Math.PI * 2;
    const angle = baseAngle + (rand() - 0.5) * 0.5;
    const speedFactor = 0.6 + rand() * 0.4;
    const easeOut = 1 - (1 - t) * (1 - t);
    const dist = EXPLOSION_MAX_RADIUS * speedFactor * easeOut;
    const px = x + Math.cos(angle) * dist;
    const py = y + Math.sin(angle) * dist;

    const chunkSize = (3.5 + rand() * 2) * (1 - t * 0.8);
    const chunkAlpha = Math.max(0, 1 - t * 1.3);

    // White core blending to tank color over time
    const whiteBlend = Math.max(0, 1 - t * 4);
    const cr = Math.round(r + (255 - r) * whiteBlend);
    const cg = Math.round(g + (255 - g) * whiteBlend);
    const cb = Math.round(b + (255 - b) * whiteBlend);

    ctx.globalAlpha = chunkAlpha;
    ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
    ctx.beginPath();
    ctx.arc(px, py, chunkSize, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fine trailing particles — small, fast, tank-colored
  const particleCount = 12;
  for (let i = 0; i < particleCount; i++) {
    const angle = (i / particleCount) * Math.PI * 2 + (rand() - 0.5) * 0.8;
    const speedFactor = 0.8 + rand() * 0.2;
    const easeOut = 1 - (1 - t) * (1 - t);
    const dist = EXPLOSION_MAX_RADIUS * 1.2 * speedFactor * easeOut;
    const px = x + Math.cos(angle) * dist;
    const py = y + Math.sin(angle) * dist;

    const particleSize = (1.5 + rand()) * (1 - t);
    const particleAlpha = Math.max(0, 1 - t * 1.5);

    ctx.globalAlpha = particleAlpha * 0.7;
    ctx.fillStyle = tankColor;
    ctx.beginPath();
    ctx.arc(px, py, particleSize, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Dust particles (wall friction visual feedback)
// ---------------------------------------------------------------------------

export interface DustParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  color: string;
  spawnTime: number;
}

const DUST_LIFETIME_MS = 400;
const DUST_RADIUS = 6;

export function drawDustParticles(ctx: CanvasRenderingContext2D, particles: DustParticle[], now: number): void {
  if (particles.length === 0) return;

  ctx.save();
  for (const p of particles) {
    const age = now - p.spawnTime;
    if (age >= DUST_LIFETIME_MS) continue;

    const t = age / DUST_LIFETIME_MS;
    // Position drifts by velocity over time
    const px = p.x + p.vx * (age / 1000);
    const py = p.y + p.vy * (age / 1000);
    // Alpha decay — start bright, fade out
    const alpha = p.alpha * (1 - t);
    if (alpha <= 0.01) continue;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(px | 0, py | 0, DUST_RADIUS * (1 - t * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export const DUST_LIFETIME = DUST_LIFETIME_MS;

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
    ctx.fillStyle = TANK_COLOR_P2;
    ctx.textAlign = 'right';
    const p2Hearts = '\u2665'.repeat(player2Lives);
    const p2Text = `${p2Hearts}  ${player2Name}`;
    ctx.fillText(p2Text, canvasWidth - HUD_PADDING, HUD_PADDING);
  }
}
