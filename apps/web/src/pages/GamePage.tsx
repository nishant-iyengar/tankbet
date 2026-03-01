import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Client } from '@colyseus/sdk';
import { useApi } from '../hooks/useApi';
import { GameEngine } from '../game/GameEngine';
import type { SeatReservation } from '../game/GameEngine';
import { CELL_SIZE, MAZE_COLS, MAZE_ROWS, PLEDGE_FEE_RATE } from '@tankbet/game-engine/constants';
import { useMobile } from '../hooks/useMobile';
import { formatCents } from '@tankbet/shared/utils';

interface CharityData {
  id: string;
  name: string;
  logoUrl: string;
}

interface GameData {
  id: string;
  status: string;
  colyseusRoomId: string | null;
  betAmountCents: number;
  creator: { id: string; username: string };
  opponent: { id: string; username: string } | null;
  creatorCharity: CharityData | null;
  opponentCharity: CharityData | null;
}

function GameResultsOverlay({
  winnerId,
  myUserId,
  game,
  opponentUsername,
}: {
  winnerId: string;
  myUserId: string;
  game: GameData;
  opponentUsername: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const didWin = winnerId === myUserId;

  // Determine which player is winner/loser
  const winnerIsCreator = winnerId === game.creator.id;
  const winnerCharity = winnerIsCreator ? game.creatorCharity : game.opponentCharity;
  const loserCharity = winnerIsCreator ? game.opponentCharity : game.creatorCharity;

  // My charity and opponent charity
  const iAmCreator = myUserId === game.creator.id;
  const myCharity = iAmCreator ? game.creatorCharity : game.opponentCharity;
  const theirCharity = iAmCreator ? game.opponentCharity : game.creatorCharity;

  const pledgeFee = Math.round(game.betAmountCents * PLEDGE_FEE_RATE);
  const netAmountCents = game.betAmountCents - pledgeFee;
  const totalDonatedCents = netAmountCents * 2;

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/80">
      <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-8 w-[420px] text-center shadow-2xl">
        {/* Win / Lose headline */}
        <p className={`text-3xl font-black tracking-wide mb-1 ${didWin ? 'text-green-400' : 'text-red-400'}`}>
          {didWin ? 'You Won!' : 'You Lost'}
        </p>
        <p className="text-slate-500 text-sm mb-7">
          {didWin ? `${opponentUsername} fought hard` : `${opponentUsername} took the win`}
        </p>

        {/* Charity reveal */}
        <div className="flex gap-4 mb-6">
          {/* My charity */}
          <div className={`flex-1 rounded-xl p-4 border ${didWin ? 'border-green-400/50 bg-green-400/5' : 'border-slate-700 bg-slate-800/50 opacity-60'}`}>
            <div className="text-xs text-slate-400 mb-2 font-medium uppercase tracking-wider">You</div>
            {myCharity ? (
              <>
                <img
                  src={myCharity.logoUrl}
                  alt={myCharity.name}
                  className="w-10 h-10 rounded-lg object-contain mx-auto mb-2"
                />
                <p className="text-white text-xs font-semibold leading-tight">{myCharity.name}</p>
              </>
            ) : (
              <p className="text-slate-500 text-xs">No charity</p>
            )}
          </div>

          {/* vs divider */}
          <div className="flex items-center">
            <span className="text-slate-600 font-bold text-sm">vs</span>
          </div>

          {/* Their charity */}
          <div className={`flex-1 rounded-xl p-4 border ${!didWin ? 'border-green-400/50 bg-green-400/5' : 'border-slate-700 bg-slate-800/50 opacity-60'}`}>
            <div className="text-xs text-slate-400 mb-2 font-medium uppercase tracking-wider">{opponentUsername}</div>
            {theirCharity ? (
              <>
                <img
                  src={theirCharity.logoUrl}
                  alt={theirCharity.name}
                  className="w-10 h-10 rounded-lg object-contain mx-auto mb-2"
                />
                <p className="text-white text-xs font-semibold leading-tight">{theirCharity.name}</p>
              </>
            ) : (
              <p className="text-slate-500 text-xs">No charity</p>
            )}
          </div>
        </div>

        {/* Donation result */}
        {winnerCharity && (
          <div className="bg-slate-800 rounded-xl px-5 py-4 mb-6 text-left">
            <p className="text-slate-400 text-xs mb-1">Donated to winner's charity</p>
            <p className="text-white text-xl font-bold tabular-nums">
              {formatCents(totalDonatedCents)}
              <span className="text-green-400 ml-2 text-sm font-semibold">→ {winnerCharity.name}</span>
            </p>
            <p className="text-slate-500 text-xs mt-1.5">
              {formatCents(game.betAmountCents)} bet × 2 players · {Math.round(PLEDGE_FEE_RATE * 100)}% processing fee applied
              {loserCharity && loserCharity.id !== winnerCharity.id && (
                <span className="block mt-0.5 text-slate-600">
                  {loserCharity.name} received nothing this round
                </span>
              )}
            </p>
          </div>
        )}

        <button
          onClick={() => navigate('/')}
          className="w-full bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg hover:bg-cyan-300 transition-colors text-sm"
        >
          Back to Home
        </button>
      </div>
    </div>
  );
}

export function GamePage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { get } = useApi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [phase, setPhase] = useState<string>('loading');
  const [winnerId, setWinnerId] = useState('');
  const [roundWinnerId, setRoundWinnerId] = useState('');
  const [myUserId, setMyUserId] = useState('');
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [error, setError] = useState('');

  const isMobile = useMobile();

  const loadAndConnect = useCallback(async (): Promise<void> => {
    try {
      const data = await get<{ game: GameData; playerIndex: 0 | 1; seatReservation: SeatReservation | null }>(`/api/games/${id}`);
      const { game, playerIndex, seatReservation } = data;

      setGameData(game);

      if (game.status !== 'IN_PROGRESS' || !game.colyseusRoomId || !game.opponent || !seatReservation) {
        setError('Game is not available');
        return;
      }

      if (!canvasRef.current) return;

      setMyUserId(playerIndex === 0 ? game.creator.id : game.opponent.id);
      setPhase('connecting');

      const wsUrl = import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001';
      const client = new Client(wsUrl);
      const engine = new GameEngine(canvasRef.current);
      engineRef.current = engine;

      engine.setPhaseChangeCallback((p, wId, rWId) => {
        setPhase(p);
        setWinnerId(wId);
        setRoundWinnerId(rWId);
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
  }, [id, get]);

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

  const opponentUsername = gameData
    ? (myUserId === gameData.creator.id ? gameData.opponent?.username : gameData.creator.username) ?? 'Opponent'
    : 'Opponent';

  return (
    <div className="min-h-screen bg-black flex items-center justify-center relative">
      <canvas
        ref={canvasRef}
        width={MAZE_COLS * CELL_SIZE}
        height={MAZE_ROWS * CELL_SIZE}
        className="block"
      />
      {(phase === 'loading' || phase === 'connecting' || phase === 'waiting') && (
        <div className="absolute text-slate-400 text-sm">
          {phase === 'loading' ? 'Loading game…' : phase === 'connecting' ? 'Connecting…' : 'Waiting for opponent…'}
        </div>
      )}
      {phase === 'resolving' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl px-10 py-6 text-center">
            {roundWinnerId === '' ? (
              <p className="text-slate-300 text-2xl font-bold tracking-wide">Tie!</p>
            ) : roundWinnerId === myUserId ? (
              <p className="text-green-400 text-2xl font-bold tracking-wide">Round Won</p>
            ) : (
              <p className="text-red-400 text-2xl font-bold tracking-wide">Round Lost</p>
            )}
            <p className="text-slate-500 text-xs mt-2">New map incoming…</p>
          </div>
        </div>
      )}
      {phase === 'ended' && gameData && (
        <GameResultsOverlay
          winnerId={winnerId}
          myUserId={myUserId}
          game={gameData}
          opponentUsername={opponentUsername}
        />
      )}
    </div>
  );
}
