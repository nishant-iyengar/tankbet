import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Client } from 'colyseus.js';
import { GameEngine } from '../game/GameEngine';
import type { SeatReservation } from '../game/GameEngine';
import { apiFetch } from '../api/client';
import { CELL_SIZE, MAZE_COLS, MAZE_ROWS } from '@tankbet/game-engine/constants';

interface TestGameResponse {
  colyseusRoomId: string;
  player1Id: string;
  player2Id: string;
}

// ─── Game canvas (rendered when URL has params) ──────────────────────────────

interface DevGameCanvasProps {
  roomId: string;
  userId: string;
  playerIndex: 0 | 1;
}

function DevGameCanvas({ roomId, userId, playerIndex }: DevGameCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [status, setStatus] = useState<string>('connecting');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    if (!canvasRef.current) return;
    const canvas = canvasRef.current;

    const wsUrl = import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001';

    async function run(): Promise<void> {
      // The server deduplicates seat reservations by userId, so StrictMode double-mounts
      // safely receive the same sessionId rather than creating two competing slots.
      const reservation = await apiFetch<SeatReservation>('/api/dev/seat', {
        method: 'POST',
        body: { roomId, userId },
      });

      if (cancelled) return;

      const client = new Client(wsUrl);
      const engine = new GameEngine(canvas);
      engineRef.current = engine;

      engine.setPhaseChangeCallback((phase) => {
        if (!cancelled) setStatus(phase);
      });

      await engine.connect(client, reservation, playerIndex, 'Player 1', 'Player 2', 0);

      if (cancelled) {
        engine.destroy();
      } else {
        setStatus('playing');
      }
    }

    run().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Connection failed');
    });

    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [roomId, userId, playerIndex]);

  if (error) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center relative">
      <div className="absolute top-3 left-3 text-xs text-slate-500 font-mono">
        DEV · Player {playerIndex + 1} · {roomId.slice(0, 8)}
      </div>
      <canvas
        ref={canvasRef}
        width={MAZE_COLS * CELL_SIZE}
        height={MAZE_ROWS * CELL_SIZE}
        className="block"
      />
      {status === 'connecting' && (
        <div className="absolute text-slate-400 text-sm">Connecting…</div>
      )}
      {status === 'ended' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-8 text-center">
            <p className="text-white text-xl font-bold mb-4">Game Over</p>
            <button
              onClick={() => window.close()}
              className="text-cyan-400 hover:text-cyan-300 text-sm underline transition-colors"
            >
              Close Tab
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Launcher (rendered when no params) ──────────────────────────────────────

interface GameLinks {
  p1: string;
  p2: string;
}

function DevGameLauncher(): React.JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<GameLinks | null>(null);

  async function createGame(): Promise<void> {
    setLoading(true);
    setError('');
    setLinks(null);
    try {
      const data = await apiFetch<TestGameResponse>('/api/dev/test-game', { method: 'POST' });

      const base = `${window.location.origin}/dev/game`;
      setLinks({
        p1: `${base}?roomId=${encodeURIComponent(data.colyseusRoomId)}&userId=${encodeURIComponent(data.player1Id)}&playerIndex=0`,
        p2: `${base}?roomId=${encodeURIComponent(data.colyseusRoomId)}&userId=${encodeURIComponent(data.player2Id)}&playerIndex=1`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create test game');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center">
      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-8 w-full max-w-lg">
        <p className="text-xs text-cyan-400 font-mono uppercase tracking-widest mb-4">
          Dev · Test Game
        </p>
        <h1 className="text-white text-lg font-bold mb-1">2-Player Dev Game</h1>
        <p className="text-slate-400 text-sm mb-6">
          Creates a live room. Open both links in separate windows — the game starts once both
          players have joined.
        </p>

        {error && <p className="text-red-400 text-xs mb-4">{error}</p>}

        <button
          onClick={() => void createGame()}
          disabled={loading}
          className="w-full bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg hover:bg-cyan-300 transition-colors text-sm disabled:opacity-40 disabled:pointer-events-none"
        >
          {loading ? 'Creating room…' : 'Create Test Game'}
        </button>

        {links && (
          <div className="mt-6 space-y-3">
            {(
              [
                { label: 'Player 1', url: links.p1, hint: 'Arrow keys + M to fire' },
                { label: 'Player 2', url: links.p2, hint: 'WASD + Q to fire' },
              ] as const
            ).map(({ label, url, hint }) => (
              <div key={label} className="bg-slate-800 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-slate-200 text-sm font-medium">{label}</p>
                  <span className="text-slate-500 text-xs">{hint}</span>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-slate-500 text-xs font-mono truncate flex-1">{url}</p>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 border border-slate-600 text-slate-300 hover:border-cyan-400/50 hover:text-cyan-300 rounded px-2.5 py-1 text-xs font-medium transition-colors"
                  >
                    Open
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Route entry point ────────────────────────────────────────────────────────

export function DevGamePage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const roomId = searchParams.get('roomId');
  const userId = searchParams.get('userId');
  const playerIndexRaw = searchParams.get('playerIndex');

  if (roomId && userId && (playerIndexRaw === '0' || playerIndexRaw === '1')) {
    return (
      <DevGameCanvas
        roomId={roomId}
        userId={userId}
        playerIndex={parseInt(playerIndexRaw, 10) as 0 | 1}
      />
    );
  }

  return <DevGameLauncher />;
}
