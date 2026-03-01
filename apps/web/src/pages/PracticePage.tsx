import { useEffect, useRef, useState, useCallback } from 'react';
import { Client } from '@colyseus/sdk';
import { GameEngine } from '../game/GameEngine';
import type { SeatReservation } from '../game/GameEngine';
import { apiFetch } from '../api/client';
import { CELL_SIZE, MAZE_COLS, MAZE_ROWS } from '@tankbet/game-engine/constants';

interface PracticeStartResponse {
  reservation: SeatReservation;
  userId: string;
}

export function PracticePage(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading');
  const [error, setError] = useState('');
  // Incrementing this key tears down + restarts the engine (New Maze)
  const [sessionKey, setSessionKey] = useState(0);

  const start = useCallback(async (): Promise<void> => {
    if (!canvasRef.current) return;

    setStatus('loading');
    setError('');

    try {
      const { reservation, userId } = await apiFetch<PracticeStartResponse>('/api/practice/start', {
        method: 'POST',
      });

      if (!canvasRef.current) return; // component may have unmounted

      const wsUrl = import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001';
      const client = new Client(wsUrl);
      const engine = new GameEngine(canvasRef.current);
      engineRef.current = engine;

      engine.setPhaseChangeCallback((phase) => {
        if (phase === 'playing') setStatus('playing');
      });

      await engine.connect(client, reservation, 0, userId, '', 0, true);
      setStatus('playing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void start();

    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [start, sessionKey]);

  function newMaze(): void {
    engineRef.current?.destroy();
    engineRef.current = null;
    setSessionKey((k) => k + 1);
  }

  return (
    <div className="flex items-start gap-3">
      <div className="relative inline-block">
        <canvas
          ref={canvasRef}
          width={MAZE_COLS * CELL_SIZE}
          height={MAZE_ROWS * CELL_SIZE}
          className="border border-slate-700/50 rounded-lg block"
        />
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
            <p className="text-slate-400 text-sm">Connecting…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
            <div className="text-center">
              <p className="text-red-400 text-sm mb-3">{error}</p>
              <button
                onClick={() => void start()}
                className="text-cyan-400 hover:text-cyan-300 text-sm underline"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>

      <button
        onClick={newMaze}
        className="border border-slate-600 text-slate-300 text-sm font-medium px-4 py-2 rounded-lg hover:border-slate-500 hover:text-white transition-colors"
      >
        New Maze
      </button>
    </div>
  );
}
