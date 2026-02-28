import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Client } from 'colyseus.js';
import { useApi } from '../hooks/useApi';
import { GameEngine } from '../game/GameEngine';
import type { SeatReservation } from '../game/GameEngine';
import { CELL_SIZE, MAZE_COLS, MAZE_ROWS } from '@tankbet/game-engine/constants';

interface GameData {
  id: string;
  status: string;
  colyseusRoomId: string | null;
  betAmountCents: number;
  creator: { id: string; username: string };
  opponent: { id: string; username: string } | null;
}

export function GamePage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { get } = useApi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [phase, setPhase] = useState<string>('loading');
  const [winnerId, setWinnerId] = useState('');
  const [error, setError] = useState('');

  const isMobile =
    window.innerWidth < 768 || /mobile|android|iphone/i.test(navigator.userAgent);

  const loadAndConnect = useCallback(async (): Promise<void> => {
    try {
      const data = await get<{ game: GameData; playerIndex: 0 | 1; seatReservation: SeatReservation | null }>(`/api/games/${id}`);
      const { game, playerIndex, seatReservation } = data;

      if (game.status !== 'IN_PROGRESS' || !game.colyseusRoomId || !game.opponent || !seatReservation) {
        setError('Game is not available');
        return;
      }

      if (!canvasRef.current) return;

      setPhase('connecting');

      const wsUrl = import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001';
      const client = new Client(wsUrl);
      const engine = new GameEngine(canvasRef.current);
      engineRef.current = engine;

      engine.setPhaseChangeCallback((p, wId) => {
        setPhase(p);
        setWinnerId(wId);
      });

      await engine.connect(
        client,
        seatReservation,
        playerIndex,
        game.creator.username,
        game.opponent.username,
        game.betAmountCents,
      );

      setPhase('playing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  }, [id, get, navigate]);

  useEffect(() => {
    if (isMobile || !id) return;

    void loadAndConnect();

    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [id, isMobile, loadAndConnect]);

  if (isMobile) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="text-center">
          <p className="text-2xl mb-3">🖥️</p>
          <h1 className="text-lg font-bold text-white mb-2">Desktop Required</h1>
          <p className="text-slate-400 text-sm">
            TankBet requires a desktop browser with a keyboard.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4 text-sm">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="text-cyan-400 hover:text-cyan-300 text-sm underline transition-colors"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center relative">
      <canvas
        ref={canvasRef}
        width={MAZE_COLS * CELL_SIZE}
        height={MAZE_ROWS * CELL_SIZE}
        className="block"
      />
      {(phase === 'loading' || phase === 'connecting') && (
        <div className="absolute text-slate-400 text-sm">
          {phase === 'loading' ? 'Loading game…' : 'Connecting…'}
        </div>
      )}
      {phase === 'ended' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-8 text-center">
            <p className="text-white text-xl font-bold mb-2">Game Over</p>
            <p className="text-slate-400 text-sm mb-6">
              {winnerId ? 'Winner determined' : 'Game ended'}
            </p>
            <button
              onClick={() => navigate('/')}
              className="bg-cyan-400 text-slate-900 font-semibold px-6 py-2 rounded-lg hover:bg-cyan-300 transition-colors text-sm"
            >
              Back to Home
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
