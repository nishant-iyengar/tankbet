/**
 * Minimal integration tests for TankRoom.
 * Starts a real Colyseus server on a test port so we can exercise the full
 * seat-reservation flow (matchMaker.reserveSeatFor → consumeSeatReservation)
 * without needing a real database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';
import { TankRoom } from '../src/rooms/TankRoom';

// ─── Mock Prisma ─────────────────────────────────────────────────────────────
// onGameEnd calls Prisma; mocking it keeps tests self-contained.
vi.mock('../src/prisma', () => ({
  prisma: {
    game: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    user: { update: vi.fn().mockResolvedValue({}) },
    contribution: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

// ─── Test server setup ────────────────────────────────────────────────────────
const TEST_PORT = 2599;
const P1 = 'player-one';
const P2 = 'player-two';

let gameServer: Server;
let client: Client;

beforeAll(async () => {
  gameServer = new Server({ transport: new WebSocketTransport() });
  gameServer.define('tank', TankRoom);
  await gameServer.listen(TEST_PORT);
  client = new Client(`ws://localhost:${TEST_PORT}`);
});

afterAll(async () => {
  await gameServer.gracefullyShutdown(false);
});

// ─── Helper ───────────────────────────────────────────────────────────────────
let gameIdCounter = 0;
async function createRoom() {
  gameIdCounter++;
  return matchMaker.createRoom('tank', {
    gameId: `test-game-${gameIdCounter}`,
    player1Id: P1,
    player2Id: P2,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('TankRoom — authorization', () => {
  it('rejects a player not in allowedUserIds (ServerError 403)', async () => {
    const room = await createRoom();
    const [listing] = await matchMaker.query({ roomId: room.roomId });
    const reservation = await matchMaker.reserveSeatFor(listing, {}, { userId: 'stranger' });
    await expect(client.consumeSeatReservation(reservation)).rejects.toBeDefined();
  });

  it('allows both authorized players to join', async () => {
    const room = await createRoom();

    const [listing1] = await matchMaker.query({ roomId: room.roomId });
    const res1 = await matchMaker.reserveSeatFor(listing1, {}, { userId: P1 });
    const c1 = await client.consumeSeatReservation(res1);
    expect(c1.sessionId).toBeTruthy();

    const [listing2] = await matchMaker.query({ roomId: room.roomId });
    const res2 = await matchMaker.reserveSeatFor(listing2, {}, { userId: P2 });
    const c2 = await client.consumeSeatReservation(res2);
    expect(c2.sessionId).toBeTruthy();

    c1.leave();
    c2.leave();
  });
});

describe('TankRoom — game flow', () => {
  it('enters countdown phase when both players join', async () => {
    const room = await createRoom();

    const [listing1] = await matchMaker.query({ roomId: room.roomId });
    const res1 = await matchMaker.reserveSeatFor(listing1, {}, { userId: P1 });
    const c1 = await client.consumeSeatReservation(res1);

    const [listing2] = await matchMaker.query({ roomId: room.roomId });
    const res2 = await matchMaker.reserveSeatFor(listing2, {}, { userId: P2 });
    const c2 = await client.consumeSeatReservation(res2);

    // Read phase from server-side room state (avoids schema deserialisation on the test client)
    await new Promise((r) => setTimeout(r, 100));
    const serverRoom = matchMaker.getLocalRoomById(room.roomId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(['countdown', 'playing']).toContain((serverRoom.state as any).phase);

    c1.leave();
    c2.leave();
  });
});
