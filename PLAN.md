# TankBet: Official Implementation Plan

> All decisions are locked. This document is the authoritative build plan.
> Primary color: `#83648F`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        MONOREPO (pnpm)                       │
│                                                             │
│  apps/web          apps/backend       packages/             │
│  (React + Vite)    (Fastify +         game-engine/          │
│  → Vercel          Colyseus)          shared/               │
│                    → Railway                                │
└─────────────────────────────────────────────────────────────┘

External Services:
  Clerk      → Phone OTP auth
  Stripe     → Card deposits + withdrawals
  Pledge.to  → Charity disbursements
  PostgreSQL → Hosted on Railway
```

---

## Monorepo Structure

```
tankbet/
├── apps/
│   ├── web/                    # React frontend (Vite + Tailwind)
│   │   ├── src/
│   │   │   ├── components/     # Reusable UI components (Button, Input, Modal...)
│   │   │   ├── pages/          # Route-level components
│   │   │   ├── game/           # Multiplayer game canvas + Colyseus client
│   │   │   ├── practice/       # Practice mode canvas (client-only engine)
│   │   │   ├── api/            # Client-side API layer (typed fetch wrappers)
│   │   │   ├── hooks/          # Custom React hooks
│   │   │   └── utils/          # Frontend-only utilities
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── backend/                # Fastify + Colyseus server
│       ├── src/
│       │   ├── server.ts       # Fastify instance + plugin registration
│       │   ├── routes/         # REST API route handlers
│       │   ├── rooms/          # Colyseus room definitions
│       │   ├── services/       # Business logic (game, payments, users)
│       │   ├── webhooks/       # Stripe webhook handlers
│       │   ├── middleware/     # Clerk auth verification
│       │   └── prisma.ts       # Prisma client singleton
│       └── package.json
│
├── packages/
│   ├── game-engine/            # Shared: physics, maze, renderer, constants
│   │   ├── src/
│   │   │   ├── constants.ts    # ALL game + rule constants (imported by both apps)
│   │   │   ├── physics.ts      # Tank movement, bullet, collision, reflection
│   │   │   ├── maze.ts         # DFS maze generator
│   │   │   └── renderer.ts     # Canvas 2D draw functions
│   │   └── package.json
│   │
│   └── shared/                 # Shared types, theme, utilities
│       ├── src/
│       │   ├── types.ts        # Shared TypeScript interfaces (Game, User, Charity...)
│       │   ├── theme.ts        # Color palette (#83648F + scale)
│       │   └── utils.ts        # String formatters, currency formatters, etc.
│       └── package.json
│
├── prisma/
│   ├── schema.prisma           # All models (see RESEARCH.md for full schema)
│   ├── migrations/
│   └── seed.ts                 # Seeds 10 charities
│
├── pnpm-workspace.yaml
├── turbo.json                  # Build orchestration (optional)
├── package.json                # Root dev scripts
├── tsconfig.base.json          # Shared TS config
└── .env.example
```

---

## Chunk 1 — Monorepo Foundation & Shared Packages

**Can start immediately. Blocks everything else.**

### 1a. Workspace Bootstrap
```bash
pnpm init
# pnpm-workspace.yaml:
packages:
  - 'apps/*'
  - 'packages/*'
```

### 1b. `packages/game-engine/src/constants.ts`
Single source of truth imported by both `apps/web` and `apps/backend`:
```typescript
// Physics
export const CELL_SIZE = 64;
export const TANK_WIDTH = 38;
export const TANK_HEIGHT = 46;
export const BARREL_LENGTH = 22;
export const TANK_SPEED = 150;            // px/s
export const TANK_ROTATION_SPEED = 135;  // deg/s
export const BULLET_SPEED = 525;         // px/s
export const MAX_BULLETS_PER_TANK = 5;
export const BULLET_LIFETIME_SECONDS = 3; // time-based; bounces are infinite
export const MAZE_COLS = 13;
export const MAZE_ROWS = 9;

// Rules
export const GRACE_PERIOD_SECONDS = 30;
export const GAME_START_COUNTDOWN_SECONDS = 3;
export const INVITE_EXPIRY_SECONDS = 120;         // 2 minutes
export const BET_AMOUNTS_CENTS = [100, 200, 500] as const;
export const MIN_DEPOSIT_CENTS = 100;
export const WITHDRAWAL_FEE_CENTS = 25;
export const PLEDGE_FEE_RATE = 0.05;

// Server
export const LIVES_PER_GAME = 5;

// Server
export const SERVER_TICK_HZ = 20;
export const CLIENT_FPS = 60;
export const INTERPOLATION_DELAY_MS = 100;
```

### 1c. `packages/game-engine/src/physics.ts`
```typescript
export type Vec2 = { x: number; y: number };

export type TankState = {
  id: string;
  x: number; y: number;
  angle: number;       // degrees, 0 = right
  speed: number;       // current movement speed
};

export type BulletState = {
  id: string;
  ownerId: string;
  x: number; y: number;
  vx: number; vy: number;
  age: number;         // seconds since fired
};

// Advance tank position given input and deltaTime
export function updateTank(tank: TankState, input: InputState, dt: number): TankState { ... }

// Advance bullet position and age
export function updateBullet(bullet: BulletState, dt: number): BulletState { ... }

// Specular reflection against axis-aligned wall segments
export function reflectBullet(bullet: BulletState, wall: WallSegment): BulletState { ... }

// Check bullet-tank collision (circle vs AABB)
export function checkBulletTankCollision(bullet: BulletState, tank: TankState): boolean { ... }
```

### 1d. `packages/game-engine/src/maze.ts`
```typescript
export type Cell = { row: number; col: number };
export type Wall = { from: Cell; to: Cell; axis: 'h' | 'v' };
export type Maze = { cols: number; rows: number; walls: Wall[] };

// Iterative DFS maze generation — produces a perfect maze (no loops, fully connected)
export function generateMaze(cols: number, rows: number, seed?: number): Maze { ... }

// Convert maze wall list into renderable line segments in pixel space
export function mazeToSegments(maze: Maze): LineSegment[] { ... }
```

### 1e. `packages/game-engine/src/renderer.ts`
```typescript
export function drawMaze(ctx: CanvasRenderingContext2D, maze: Maze): void { ... }
export function drawTank(ctx: CanvasRenderingContext2D, tank: TankState, color: string): void { ... }
export function drawBullet(ctx: CanvasRenderingContext2D, bullet: BulletState): void { ... }
export function drawCountdown(ctx: CanvasRenderingContext2D, count: number): void { ... }
```

### 1f. `packages/shared/src/theme.ts`
```typescript
export const colors = {
  primary:     '#83648F',
  primary100:  '#f3edf5',
  primary200:  '#d9c8de',
  primary300:  '#bfa3c7',
  primary400:  '#a47eb0',
  primary500:  '#83648F',  // brand
  primary600:  '#6a5074',
  primary700:  '#503c58',
  primary800:  '#37293d',
  primary900:  '#1e1522',
  text:        '#1a1a1a',
  textMuted:   '#6b7280',
  border:      '#e5e7eb',
  surface:     '#ffffff',
  background:  '#f9fafb',
  error:       '#ef4444',
  success:     '#22c55e',
} as const;
```

### 1g. `packages/shared/src/types.ts`
```typescript
// Shared between frontend API layer and backend routes
export type BetAmountCents = 100 | 200 | 500;
export type GameStatus = 'PENDING_ACCEPTANCE' | 'IN_PROGRESS' | 'COMPLETED' | 'FORFEITED' | 'REJECTED' | 'EXPIRED';
export type ContributionRole = 'WINNER' | 'LOSER';

export interface PublicUser {
  id: string;
  username: string;
  balance: number;        // cents
  totalDonatedCents: number;
}

export interface PublicCharity {
  id: string;
  name: string;
  logoUrl: string;
  description: string;
}

export interface GameInvitePreview {
  id: string;
  betAmountCents: BetAmountCents;
  creatorUsername: string;
  inviteExpiresAt: string;
  status: GameStatus;
}

export interface DonationHistoryEntry {
  gameId: string;
  role: ContributionRole;
  charityName: string;
  charityLogoUrl: string;
  betAmountCents: number;
  netAmountCents: number;     // after Pledge.to fee
  displayAmountCents: number; // WIN = net×2, LOSE = net×1
  createdAt: string;
}
```

---

## Chunk 2 — Database Schema & Seed

**Can start in parallel with Chunk 1.**

### 2a. Prisma Schema
Full schema as defined in `RESEARCH.md`. Tables: `User`, `Charity`, `Game`, `Contribution`, `Disbursement`, `Deposit`, `Withdrawal`.

### 2b. Railway Postgres Setup
- Create Railway project
- Add Postgres plugin → copy `DATABASE_URL`
- `prisma migrate deploy` on first push

### 2c. Seed File (`prisma/seed.ts`)
```typescript
const charities = [
  { name: 'American Red Cross',              ein: '53-0196605',  pledgeSlug: 'american-red-cross',              logoUrl: '...', website: 'redcross.org',   description: 'Disaster relief and emergency assistance.' },
  { name: 'ASPCA',                           ein: '13-1623829',  pledgeSlug: 'aspca',                           logoUrl: '...', website: 'aspca.org',     description: 'Preventing cruelty to animals.' },
  { name: 'Doctors Without Borders',         ein: '13-3433452',  pledgeSlug: 'doctors-without-borders-usa',    logoUrl: '...', website: 'msf.org',       description: 'Medical aid in crisis zones worldwide.' },
  { name: 'St. Jude Research Hospital',      ein: '35-1044585',  pledgeSlug: 'st-jude-childrens-research',     logoUrl: '...', website: 'stjude.org',    description: "Pioneering research for children's cancer." },
  { name: 'World Wildlife Fund',             ein: '52-1693387',  pledgeSlug: 'world-wildlife-fund',             logoUrl: '...', website: 'worldwildlife.org', description: 'Protecting nature and wildlife globally.' },
  { name: 'Feeding America',                 ein: '36-3673599',  pledgeSlug: 'feeding-america',                 logoUrl: '...', website: 'feedingamerica.org', description: 'The largest domestic hunger-relief org.' },
  { name: 'Habitat for Humanity',            ein: '91-1914868',  pledgeSlug: 'habitat-for-humanity',            logoUrl: '...', website: 'habitat.org',   description: 'Building affordable homes for families.' },
  { name: 'NAMI',                            ein: '43-1201653',  pledgeSlug: 'nami',                            logoUrl: '...', website: 'nami.org',      description: 'Mental health education and advocacy.' },
  { name: 'Boys & Girls Clubs of America',   ein: '13-5562976',  pledgeSlug: 'boys-and-girls-clubs',            logoUrl: '...', website: 'bgca.org',      description: 'Safe spaces for young people to grow.' },
  { name: 'Make-A-Wish Foundation',          ein: '86-0418982',  pledgeSlug: 'make-a-wish-america',             logoUrl: '...', website: 'wish.org',      description: 'Granting wishes for children with illnesses.' },
];
```

---

## Chunk 3 — Backend Core & Auth

**Depends on: Chunks 1, 2.**

### 3a. Fastify Server (`apps/backend/src/server.ts`)
```typescript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { clerkPlugin, getAuth } from '@clerk/fastify';
import websocket from '@fastify/websocket';
import { Server as ColyseusServer } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { TankRoom } from './rooms/TankRoom';

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: process.env.FRONTEND_URL, credentials: true });
await fastify.register(clerkPlugin, { publishableKey, secretKey });
await fastify.register(websocket);

// Colyseus shares the same http.Server
const gameServer = new Server({
  transport: new WebSocketTransport({ server: fastify.server }),
});
gameServer.define('tank_room', TankRoom);

// Route registration
fastify.register(userRoutes,       { prefix: '/api/users' });
fastify.register(gameRoutes,       { prefix: '/api/games' });
fastify.register(paymentRoutes,    { prefix: '/api/payments' });
fastify.register(charityRoutes,    { prefix: '/api/charities' });
fastify.register(webhookRoutes,    { prefix: '/api/webhooks' });

await fastify.listen({ port: 3001, host: '0.0.0.0' });
```

### 3b. Clerk Auth Middleware (`apps/backend/src/middleware/auth.ts`)
```typescript
import { getAuth } from '@clerk/fastify';
import { FastifyRequest, FastifyReply } from 'fastify';

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = getAuth(req);
  if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

  const user = await prisma.user.findUnique({ where: { clerkId: userId } });
  if (!user) return reply.status(404).send({ error: 'User not found' });

  req.dbUser = user;  // augment request type
}
```

### 3c. User Routes (`apps/backend/src/routes/users.ts`)
```
POST   /api/users/onboard          Create user after Clerk signup (username gen, first-time only)
GET    /api/users/me               Fetch current user profile + balance
POST   /api/users/accept-tos       Record ToS acceptance (IP, timestamp, version, DOB)
GET    /api/users/donation-history Paginated DonationHistoryEntry[]
```

### 3d. Username Generation
Wordlists for `adjective-adjective-noun` format (e.g. `delicious-blue-seal`):
```typescript
// packages/shared/src/username.ts
export function generateUsername(): string {
  const adj1 = pick(adjectives);
  const adj2 = pick(adjectives);
  const noun = pick(nouns);
  return `${adj1}-${adj2}-${noun}`;
}
// Retry on collision (Prisma unique constraint error → generate new)
```

---

## Chunk 4 — Payment System

**Depends on: Chunk 3.**

### 4a. Deposit Flow

**Endpoint: `POST /api/payments/create-deposit`**
```typescript
// Input: { amountCents: number }
// Validate: amountCents >= MIN_DEPOSIT_CENTS, integer, > 0

const paymentIntent = await stripe.paymentIntents.create({
  amount: amountCents,
  currency: 'usd',
  customer: user.stripeCustomerId,
  payment_method_types: ['card'],
  metadata: { userId: user.id, amountCents: String(amountCents) },
});
// Return: { clientSecret: paymentIntent.client_secret }
```

**Webhook: `POST /api/webhooks/stripe`**
```typescript
// Verify Stripe signature first
switch (event.type) {
  case 'payment_intent.succeeded':
    const { userId, amountCents } = event.data.object.metadata;
    await prisma.$transaction([
      prisma.deposit.create({ data: { userId, amountCents, stripeFeesCents: ..., status: 'SUCCEEDED', stripePaymentIntentId: pi.id } }),
      prisma.user.update({ where: { id: userId }, data: { balance: { increment: Number(amountCents) } } }),
    ]);
    break;

  case 'charge.dispute.created':
    // TODO: Handle dispute events properly.
    // When a charge is reversed, ideally we should:
    //   1. Mark the associated Deposit as DISPUTED
    //   2. Claw back the user's balance if still available
    //   3. Mark linked Contributions as DISPUTED
    //   4. Investigate Pledge.to disbursement reversal if already sent
    // For now: log and trigger a manual alert.
    console.error('[DISPUTE] Manual review required:', event.data.object.id);
    break;
}
```

### 4b. Stripe Customer Setup (`POST /api/payments/setup`)
```typescript
// Creates Stripe Customer for user if not exists
// Returns: { customerId } — stored on user.stripeCustomerId
```

### 4c. Withdrawal Flow

**Endpoint: `POST /api/payments/withdraw`**
```typescript
// Input: { amountCents: number }
// Validate: amountCents > WITHDRAWAL_FEE_CENTS (must be > $0.25 to net anything positive)
// Net = amountCents - WITHDRAWAL_FEE_CENTS

// For MVP: collect user bank account via Stripe Financial Connections
// Then initiate ACH payout via Stripe Payouts API
// OR: manual payout queue — log the request and process manually
// NOTE: withdrawal payout mechanism is lowest priority MVP item

await prisma.$transaction([
  prisma.user.update({ where: { id: userId }, data: { balance: { decrement: amountCents } } }),
  prisma.withdrawal.create({ data: { userId, requestedAmountCents: amountCents, feeCents: WITHDRAWAL_FEE_CENTS, netAmountCents: amountCents - WITHDRAWAL_FEE_CENTS, status: 'PENDING' } }),
]);
```

---

## Chunk 5 — Game Server (Colyseus)

**Depends on: Chunks 1, 3.**

### 5a. Room State Schema (`apps/backend/src/rooms/TankRoomState.ts`)
```typescript
import { Schema, type, MapSchema, ArraySchema } from '@colyseus/schema';

class Bullet extends Schema {
  @type('string') id: string = '';
  @type('string') ownerId: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') vx: number = 0;
  @type('float32') vy: number = 0;
  @type('float32') age: number = 0;
}

class Tank extends Schema {
  @type('string') id: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') angle: number = 0;
  @type('boolean') alive: boolean = true;
}

class TankRoomState extends Schema {
  @type({ map: Tank }) tanks = new MapSchema<Tank>();
  @type([Bullet]) bullets = new ArraySchema<Bullet>();
  @type('int8') countdown: number = GAME_START_COUNTDOWN_SECONDS;
  @type('string') phase: string = 'countdown'; // 'countdown' | 'playing' | 'ended'
  @type('string') winnerId: string = '';
  @type({ map: 'int8' }) lives = new MapSchema<number>();  // playerId → lives remaining (starts at LIVES_PER_GAME)
  @type('number[]') mazeWalls: number[] = [];  // serialized flat array: [x1,y1,x2,y2, ...]
}
```

### 5b. Room Logic (`apps/backend/src/rooms/TankRoom.ts`)
```typescript
export class TankRoom extends Room<TankRoomState> {
  maxClients = 2;
  gameDbId: string = '';

  async onCreate(options: { gameId: string }) {
    this.gameDbId = options.gameId;
    this.setState(new TankRoomState());

    // Generate maze using shared package
    const maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.state.mazeWalls = serializeMaze(maze);

    // Countdown phase
    let count = GAME_START_COUNTDOWN_SECONDS;
    const countdownInterval = setInterval(() => {
      this.state.countdown = count;
      count--;
      if (count < 0) {
        clearInterval(countdownInterval);
        this.state.phase = 'playing';
        this.startGameLoop();
      }
    }, 1000);
  }

  onJoin(client: Client, options: { userId: string }) {
    // Place tank at spawn position
    const tank = new Tank();
    tank.id = options.userId;
    tank.x = spawnX; tank.y = spawnY;
    this.state.tanks.set(client.sessionId, tank);
  }

  onMessage(client: Client, message: { keys: InputKeys; seq: number }) {
    this.pendingInputs.set(client.sessionId, message.keys);
  }

  startGameLoop() {
    // 20Hz server tick using shared physics
    this.setSimulationInterval((dt) => this.tick(dt), 1000 / SERVER_TICK_HZ);
  }

  tick(dt: number) {
    // 1. Process pending inputs → move tanks (uses shared physics.ts)
    // 2. Advance bullets (age, position)
    // 3. Check bullet expiry (age >= BULLET_LIFETIME_SECONDS → remove)
    // 4. Check bullet-wall collisions → reflect (uses shared physics.ts)
    // 5. Check bullet-tank collisions → kill tank → trigger end
  }

  onBulletHitTank(killedId: string) {
    const lives = this.state.lives.get(killedId)! - 1;
    this.state.lives.set(killedId, lives);

    if (lives <= 0) {
      // Game over — this player ran out of lives
      const [winnerId, loserId] = [...this.state.lives.entries()]
        .sort((a, b) => b[1] - a[1])  // winner has more lives
        .map(([id]) => id) as [string, string];
      this.onGameEnd(winnerId, loserId);
    } else {
      // Respawn: mark tank dead briefly, then respawn at a valid maze position
      this.state.tanks.get(killedId)!.alive = false;
      setTimeout(() => {
        const tank = this.state.tanks.get(killedId)!;
        const spawn = getRandomSpawn(this.maze, this.state.tanks);
        tank.x = spawn.x; tank.y = spawn.y; tank.angle = 0; tank.alive = true;
      }, 1500);  // 1.5s respawn delay
    }
  }

  async onGameEnd(winnerId: string, loserId: string) {
    this.state.phase = 'ended';
    this.state.winnerId = winnerId;
    const winnerLivesRemaining = this.state.lives.get(winnerId) ?? 0;

    // Fetch game from DB to get charity selections + bet amount
    const game = await prisma.game.findUnique({
      where: { id: this.gameDbId },
      include: { creatorCharity: true, opponentCharity: true },
    });

    const betAmountCents = game.betAmountCents;
    const pledgeFee = Math.round(betAmountCents * PLEDGE_FEE_RATE);
    const netAmountCents = betAmountCents - pledgeFee;
    const winnerCharityId = /* winner's chosen charity */;

    await prisma.$transaction([
      // Mark game complete — store winner's remaining lives as margin of victory
      prisma.game.update({ where: { id: this.gameDbId }, data: { status: 'COMPLETED', winnerId, loserId, winnerLivesRemaining, endedAt: new Date(), durationSeconds: ... } }),
      // Debit both balances
      prisma.user.update({ where: { id: winnerId }, data: { balance: { decrement: betAmountCents }, totalDonatedCents: { increment: netAmountCents * 2 }, reservedBalance: { decrement: betAmountCents } } }),
      prisma.user.update({ where: { id: loserId }, data: { balance: { decrement: betAmountCents }, totalDonatedCents: { increment: netAmountCents }, reservedBalance: { decrement: betAmountCents } } }),
      // Create two Contributions (both point to winner's charity)
      prisma.contribution.create({ data: { userId: winnerId, gameId: this.gameDbId, charityId: winnerCharityId, role: 'WINNER', betAmountCents, netAmountCents } }),
      prisma.contribution.create({ data: { userId: loserId, gameId: this.gameDbId, charityId: winnerCharityId, role: 'LOSER', betAmountCents, netAmountCents } }),
    ]);
  }

  async onLeave(client: Client, consented: boolean) {
    if (this.state.phase !== 'playing') return;
    // Start grace period
    try {
      await this.allowReconnection(client, GRACE_PERIOD_SECONDS);
      // Reconnected successfully — resume
    } catch {
      // Did not reconnect in time → forfeit
      const loserId = client.sessionId;
      const winnerId = /* the other player */;
      await this.onForfeit(winnerId, loserId);
    }
  }
}
```

### 5c. Invite / Game Service (`apps/backend/src/services/game.service.ts`)
```typescript
// createInvite: reserve balance, generate token, set inviteExpiresAt = now + 120s
// acceptInvite: validate token not expired, validate opponent balance, set status IN_PROGRESS
// rejectInvite: release creator's reservedBalance, set status REJECTED
// expireStaleInvites: cron job every 30s — find PENDING_ACCEPTANCE games past expiry → set EXPIRED, release reserves
```

### 5d. Game Routes (`apps/backend/src/routes/games.ts`)
```
POST  /api/games/create               Create invite (validate balance, reserve, return invite URL)
GET   /api/games/invite/:token        Fetch invite preview (GameInvitePreview) — works unauthed
POST  /api/games/invite/:token/accept Accept invite (requires auth + Stripe setup)
POST  /api/games/invite/:token/reject Reject invite
GET   /api/games/:id                  Fetch game state (for reconnect)
```

---

## Chunk 6 — Game Client Engine

**Depends on: Chunk 1. Can run in parallel with Chunk 3.**

### 6a. Multiplayer Game Loop (`apps/web/src/game/GameEngine.ts`)
```typescript
import * as Colyseus from 'colyseus.js';
import { updateTank, updateBullet, reflectBullet } from '@tankbet/game-engine/physics';
import { drawMaze, drawTank, drawBullet, drawCountdown } from '@tankbet/game-engine/renderer';
import { INTERPOLATION_DELAY_MS, CLIENT_FPS } from '@tankbet/game-engine/constants';

export class GameEngine {
  private client: Colyseus.Client;
  private room: Colyseus.Room;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stateBuffer: { timestamp: number; state: SnapshotState }[] = [];

  // Snapshot interpolation: render at (now - INTERPOLATION_DELAY_MS)
  // Always have >= 2 snapshots to interpolate between

  connect(gameId: string, token: string): Promise<void> { ... }
  sendInput(keys: InputKeys): void { ... }  // called on every keydown/keyup
  startRenderLoop(): void { ... }           // requestAnimationFrame at 60 FPS
  destroy(): void { ... }                   // cleanup
}
```

### 6b. Input Handler (`apps/web/src/game/InputHandler.ts`)
```typescript
// P1 (creator): Arrow keys + M to fire
// P2 (opponent): WASD + Q to fire
// Normalized InputKeys: { up, down, left, right, fire }
// Debounce: send input on change, not on every frame

export class InputHandler {
  private keys: InputKeys = { up: false, down: false, left: false, right: false, fire: false };
  private seq = 0;
  private onInput: (keys: InputKeys, seq: number) => void;

  attach(playerIndex: 0 | 1, onInput: (keys: InputKeys, seq: number) => void): void { ... }
  detach(): void { ... }
}
```

### 6c. Practice Mode (`apps/web/src/practice/PracticeEngine.ts`)
```typescript
// Client-only loop — no Colyseus, no server
// Uses identical physics + renderer from @tankbet/game-engine
// Single tank, infinite lives, respawns at maze center on death

export class PracticeEngine {
  private canvas: HTMLCanvasElement;
  private maze: Maze;
  private tank: TankState;
  private bullets: BulletState[] = [];
  private lastTime = 0;

  start(): void {
    this.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    this.tank = spawnTank(this.maze);
    requestAnimationFrame(this.loop.bind(this));
  }

  private loop(timestamp: number): void {
    const dt = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;
    this.update(dt);
    this.draw();
    requestAnimationFrame(this.loop.bind(this));
  }
}
```

---

## Chunk 7 — Invite & Lobby System

**Depends on: Chunks 3, 4.**

### 7a. Real-time Invite Status
When creator shares a link, they stay on a "waiting for opponent" screen. This screen uses a Colyseus lobby room (not TankRoom) or a simple SSE/WebSocket to listen for acceptance.

Option: lightweight Colyseus "lobby" room per pending invite:
```typescript
// LobbyRoom — 1 creator, listens for accept/reject event
// On accept: broadcasts { type: 'ACCEPTED', opponentUsername }
// Creator transitions to game countdown screen
```

### 7b. Invite Landing Page Flow (`/invite/[token]`)
```
1. Fetch GET /api/games/invite/:token (unauthed)
   → If EXPIRED or REJECTED: show "This invite is no longer valid"
   → If IN_PROGRESS: show "This game already started"
   → If PENDING_ACCEPTANCE: show invite card

2. Invite card displays:
   - Creator's username
   - Bet amount (e.g. "You're playing for $2")
   - Expiry countdown timer
   - [Accept] [Reject] buttons

3. If user clicks Accept:
   a. If not logged in → Clerk sign-in modal (phone OTP)
   b. If no Stripe setup → Stripe card setup modal
   c. If insufficient balance → deposit modal
   d. If charity not selected → charity picker modal
   e. POST /api/games/invite/:token/accept
   f. Transition to countdown screen (/game/[id])

4. Real-time update to creator via Colyseus LobbyRoom broadcast
```

### 7c. Balance Lock Logic
```typescript
// On createInvite:
await prisma.user.update({
  where: { id: creatorId },
  data: {
    reservedBalance: { increment: betAmountCents },
    activeGameId: game.id,
  },
});

// On expiry / rejection:
await prisma.user.update({
  where: { id: creatorId },
  data: {
    reservedBalance: { decrement: betAmountCents },
    activeGameId: null,
  },
});

// Display balance to user = balance - reservedBalance
```

---

## Chunk 8 — Frontend Auth & Onboarding

**Depends on: Chunks 1, 3.**

### 8a. Onboarding Steps (sequential)
```
Step 1: Phone Number Input + OTP (Clerk)
         ↓ on success
Step 2: Date of Birth
         - Input: MM/DD/YYYY
         - Validate: must be 18+
         - Store on User.dateOfBirth
         ↓ on submit
Step 3: Consent Form
         - Display full ToS (charity gaming terms)
         - Single checkbox: "I have read and agree to the Terms of Service"
         - [I Agree] button
         - POST /api/users/accept-tos (sends IP from server, user agent from client)
         ↓ on agree
Step 4: Add Card (Stripe)
         - Stripe PaymentElement (card only)
         - "You need a card on file to deposit funds and play"
         - [Save Card] button
         - Success → Stripe Customer created + card saved
         ↓ on save
Home page
```

### 8b. Clerk Provider Setup
```tsx
// apps/web/src/main.tsx
import { ClerkProvider } from '@clerk/clerk-react';

<ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
  <App />
</ClerkProvider>
```

### 8c. Auth Guard
```tsx
// All app routes require auth except /invite/[token] and /policy
// Redirect unauthenticated users to /login
// Redirect authenticated users who haven't completed onboarding to /onboarding
```

---

## Chunk 9 — Frontend Main UI

**Depends on: Chunks 1, 3, 4, 7, 8.**

### 9a. Layout (`apps/web/src/components/Layout.tsx`)
```tsx
// Left sidebar (fixed, 200px):
//   Logo "TankBet" (primary color)
//   [Home]     → /
//   [Practice] → /practice
//   [Rules]    → /rules
//   ─────────────────
//   [Policy]   → /policy (muted, small)
//
// Top right (always visible):
//   "$X.XX donated"  ← clickable → /donations
//   "username" dropdown → [Log out]
//
// Main content area (fluid)
```

### 9b. Home Page (`/`)
```
┌────────────────────────────────────────────────┐
│ Welcome, delicious-blue-seal                   │
│                                                │
│  [Create Game]                                 │
│   ○ $1   ● $2   ○ $5   ← bet selector         │
│   Pick your charity: [charity picker grid]     │
│   [Generate Link]                              │
│                                                │
│  ──────────────────────────────────────────    │
│  Your Balance:  $8.00                          │
│  [Add Funds]    [Withdraw]                     │
│                                                │
│  "A $0.25 processing fee applies to            │
│   all withdrawals."                            │
└────────────────────────────────────────────────┘
```

### 9c. Donation History Page (`/donations`)
```
Total Donated: $47.25

[  Feb 25  Won vs quick-red-fox    → $9.50  American Red Cross  ↗  ]
[  Feb 24  Lost vs bold-blue-bear  → $1.90  ASPCA              ↗  ]
...
```
- "Won": display = netAmountCents × 2
- "Lost": display = netAmountCents
- Shows opposing charity in grey under winner's charity

### 9d. Game Invite Page (`/invite/[token]`)
```
┌────────────────────────────────────────────────┐
│  delicious-blue-seal wants to play              │
│                                                │
│  Bet: $2.00                                    │
│  Expires in: 1:23                              │
│                                                │
│  Pick your charity:                            │
│  [charity grid — required to accept]           │
│                                                │
│  [Accept]          [Decline]                   │
└────────────────────────────────────────────────┘
```

### 9e. Charity Reveal Overlay (post-game)
```
┌────────────────────────────────────────────────┐
│                   YOU WON!                     │
│                                                │
│  Your charity:        Opponent's charity:      │
│  [Red Cross logo]     [ASPCA logo]             │
│  American Red Cross   ASPCA                    │
│                                                │
│  $9.50 donated to American Red Cross           │
│  (your $1.90 + opponent's $1.90)               │
│                                                │
│  [Play Again]    [Share Result]                │
└────────────────────────────────────────────────┘
```

### 9f. Rules Page (`/rules`)
Game rules displayed as clean prose + bullet points. Includes:
- Game objective
- Controls (P1: arrows + M, P2: WASD + Q)
- Bullet behavior (3 seconds, infinite bounces)
- Betting rules ($1, $2, $5)
- Grace period (30 seconds to reconnect or forfeit)
- Charity model explanation
- Policy snippet at bottom: "By playing, you agree to our [Terms of Service]"

### 9g. Policy Page (`/policy`)
Full rendered ToS from a static file. Accessible without auth.

### 9h. Deposit Modal
```tsx
// Stripe PaymentElement in a modal
// Input: custom dollar amount (integer, min $1)
// Shows: "Funds will be available immediately after confirmation"
// On success: balance updates in real-time (optimistic or webhook-triggered)
```

### 9i. Withdrawal Modal
```tsx
// Input: amount to withdraw (max = balance - $0.25)
// Shows: "A $0.25 processing fee will be deducted. You'll receive $X.XX"
// Also shown in policy: "per our Terms of Service"
```

---

## Chunk 10 — Game Canvas UI

**Depends on: Chunks 5, 6.**

### 10a. Game Page (`/game/[id]`)
```tsx
// Mount canvas (full-height, responsive aspect ratio)
// Initialize GameEngine with gameId + Clerk session token
// Show countdown overlay (3, 2, 1, GO!)
// Render in-game HUD:
//   Top-left:  creator username + "?" charity (hidden)
//   Top-right: opponent username + "?" charity (hidden)
//   Bottom:    "Playing for $2.00"
// On game end → show CharityRevealOverlay

// Desktop-only guard:
// If window.innerWidth < 768 OR /mobile|android|iphone/i.test(navigator.userAgent):
//   → show: "TankBet requires a desktop browser with a keyboard."
```

### 10b. Countdown Overlay
```tsx
// Full-screen overlay that fades out each number
// 3 → 2 → 1 → GO! → disappear
// Driven by Colyseus room state (countdown field)
```

### 10c. Grace Period UI
```tsx
// When opponent disconnects:
//   → show: "Opponent disconnected — waiting 30 seconds..."
//   → countdown timer
//   → if reconnects: "Opponent reconnected!" → resume
//   → if timeout: CharityRevealOverlay (you won by forfeit)
```

---

## Chunk 11 — Pledge.to Integration

**Depends on: Chunks 2, 5.**

### 11a. Pledge.to API Client (`apps/backend/src/services/pledge.service.ts`)
```typescript
export async function disburseToPledge(
  charitySlug: string,
  amountCents: number,
  contributionIds: string[],
): Promise<string> {
  // POST to Pledge.to API
  // Returns pledgeDonationId
  // Mark all Contributions as disbursed → set disbursementId
}
```

### 11b. Disbursement Cron Job
```typescript
// Run weekly (or trigger via admin endpoint for MVP)
// 1. GROUP BY charityId WHERE disbursementId IS NULL
// 2. For each charity: sum netAmountCents → call disburseToPledge
// 3. Create Disbursement record
// 4. Update all linked Contributions with disbursementId
```

---

## Chunk 12 — Deployment & Environment

**Can start once basic server runs.**

### 12a. Environment Variables
```bash
# apps/backend
DATABASE_URL=
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PLEDGE_API_KEY=
FRONTEND_URL=https://tankbet.io

# apps/web
VITE_CLERK_PUBLISHABLE_KEY=
VITE_STRIPE_PUBLISHABLE_KEY=
VITE_API_URL=https://api.tankbet.io
VITE_WS_URL=wss://api.tankbet.io
```

### 12b. Railway Config (`apps/backend`)
```toml
# railway.toml
[build]
  builder = "NIXPACKS"
  buildCommand = "pnpm --filter @tankbet/backend build"

[deploy]
  startCommand = "node dist/server.js"
  restartPolicyType = "ON_FAILURE"
```

### 12c. Vercel Config (`apps/web`)
```json
// apps/web/vercel.json
{
  "buildCommand": "cd ../.. && pnpm --filter @tankbet/web build",
  "outputDirectory": "apps/web/dist",
  "installCommand": "cd ../.. && pnpm install"
}
```

### 12d. Domain
- Register `tankbet.io` via Cloudflare Registrar
- Point `tankbet.io` → Vercel
- Point `api.tankbet.io` → Railway service URL

---

## Parallelization Strategy

These chunks can be worked on simultaneously by multiple agents:

```
Phase 1 (Parallel)
  Agent A: Chunk 1 — Monorepo + shared packages + game-engine
  Agent B: Chunk 2 — Prisma schema + seed + Railway Postgres

Phase 2 (Parallel, after Phase 1)
  Agent A: Chunk 3 — Backend core + auth + user routes
  Agent B: Chunk 6 — Game client engine + practice mode

Phase 3 (Parallel, after Phase 2)
  Agent A: Chunk 4 — Stripe deposits + webhooks + withdrawals
  Agent B: Chunk 5 — Colyseus game room + server-side game loop
  Agent C: Chunk 8 — Frontend auth + onboarding flow

Phase 4 (Parallel, after Phase 3)
  Agent A: Chunk 7 — Invite system + lobby WebSocket
  Agent B: Chunk 9 — Main UI (home, donations, rules, policy, modals)

Phase 5 (Parallel, after Phase 4)
  Agent A: Chunk 10 — Game canvas + countdown + grace period UI
  Agent B: Chunk 11 — Pledge.to integration + disbursement cron

Phase 6
  All: Chunk 12 — Deployment + environment config
```

---

## Accounts to Create Before Starting

| Service | URL | What to get |
|---|---|---|
| Clerk | clerk.com | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` |
| Stripe | stripe.com | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Pledge.to | pledge.to | `PLEDGE_API_KEY` |
| Railway | railway.app | Deploy backend + Postgres |
| Vercel | vercel.com | Deploy frontend |
| Cloudflare | cloudflare.com | Register `tankbet.io` |
