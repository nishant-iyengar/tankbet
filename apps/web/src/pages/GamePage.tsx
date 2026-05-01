import { useContext, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Client } from '@colyseus/sdk';
import { useApi } from '../hooks/useApi';
import { GameEngine } from '../game/GameEngine';
import type { SeatReservation } from '../game/GameEngine';
import { CELL_SIZE, MAZE_COLS, MAZE_ROWS } from '@tankbet/game-engine/constants';
import { useMobile } from '../hooks/useMobile';
import { ErrorAlert } from '../components/ErrorAlert';
import { reconnectStorageKey, storeReconnectToken, clearReconnectToken } from '../utils/reconnectStorage';
import { DevAuthContext } from '../auth/DevAuthContext';
import { apiFetch } from '../api/client';
import { BotPlayer } from '../game/BotPlayer';

interface GameData {
  id: string;
  status: string;
  colyseusRoomId: string | null;
  winnerId: string | null;
  loserId: string | null;
  creator: { id: string; username: string };
  opponent: { id: string; username: string } | null;
}

interface GameFetchResponse {
  game: {
    id: string;
    status: string;
    colyseusRoomId: string | null;
    winnerId: string | null;
    loserId: string | null;
    creator: { id: string; username: string };
    opponent: { id: string; username: string } | null;
  };
  playerIndex: 0 | 1;
  seatReservation: SeatReservation | null;
}

function GameResultsOverlay({
  winnerId,
  myUserId,
  opponentUsername,
  isBotGame,
  onRetry,
}: {
  winnerId: string;
  myUserId: string;
  opponentUsername: string;
  isBotGame: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const didWin = winnerId === myUserId;

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/80">
      <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-8 w-[420px] text-center shadow-2xl">
        <p className={`text-3xl font-black tracking-wide mb-1 ${didWin ? 'text-green-400' : 'text-red-400'}`}>
          {didWin ? 'You Won!' : 'You Lost'}
        </p>
        <p className="text-slate-500 text-sm mb-7">
          {didWin ? `${opponentUsername} fought hard` : `${opponentUsername} took the win`}
        </p>

        {isBotGame ? (
          <div className="flex gap-3">
            <button
              onClick={() => navigate('/')}
              className="flex-1 border border-slate-600 text-slate-300 py-2.5 rounded-lg text-sm font-medium hover:border-slate-400 hover:text-white transition-colors"
            >
              Back to Home
            </button>
            <button
              onClick={onRetry}
              className="flex-1 bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg hover:bg-cyan-300 transition-colors text-sm"
            >
              Play Again
            </button>
          </div>
        ) : (
          <button
            onClick={() => navigate('/')}
            className="w-full bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg hover:bg-cyan-300 transition-colors text-sm"
          >
            Back to Home
          </button>
        )}
      </div>
    </div>
  );
}

export function GamePage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isBotGame = searchParams.get('bot') === 'true';
  const devAuth = useContext(DevAuthContext);
  const { get } = useApi();
  const getRef = useRef(get);
  getRef.current = get;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const connectingRef = useRef(false);
  const [phase, setPhase] = useState<string>('loading');
  const [winnerId, setWinnerId] = useState('');
  const [roundWinnerId, setRoundWinnerId] = useState('');
  const [myUserId, setMyUserId] = useState('');
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [error, setError] = useState('');
  const [showLeaveModal, setShowLeaveModal] = useState(false);

  const isMobile = useMobile();

  function handleLeaveConfirm(): void {
    setShowLeaveModal(false);
    if (id) {
      clearReconnectToken(id);
    }
    // Signal HomePage to skip the active-game redirect (race: forfeit may not
    // have been processed server-side by the time /me returns). Use a timestamp
    // so it survives StrictMode double-render (expires after 5 seconds).
    sessionStorage.setItem('skipActiveGameRedirect', String(Date.now()));
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) {
      void engine.forfeit();
    }
    navigate('/');
  }

  async function handleBotRetry(): Promise<void> {
    const currentUser = devAuth?.devUser;
    if (!currentUser) return;

    const devAdminIds = ['dev-admin-1', 'dev-admin-2'];
    const opponentClerkId = devAdminIds.find((cid) => cid !== currentUser.clerkId);
    if (!opponentClerkId) return;

    const wsUrl: string = import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001';
    const myToken = `DevToken ${currentUser.clerkId}`;
    const opponentToken = `DevToken ${opponentClerkId}`;

    // Create a new test game
    const createResult = await apiFetch<{ gameId: string }>('/api/dev/test-game', {
      method: 'POST',
      body: { opponentClerkId },
      token: myToken,
    });

    const newGameId = createResult.gameId;

    // Get seat reservation for the opponent
    const opponentData = await apiFetch<GameFetchResponse>(`/api/games/${newGameId}`, {
      token: opponentToken,
    });

    if (!opponentData.seatReservation) return;

    const botClient = new Client(wsUrl);
    const bot = new BotPlayer();
    await bot.connect(botClient, opponentData.seatReservation);

    // Tear down the old game engine so the effect can run cleanly with the new id
    if (engineRef.current) {
      engineRef.current.destroy();
      engineRef.current = null;
    }
    connectingRef.current = false;
    setPhase('loading');
    setError('');
    setGameData(null);

    navigate(`/game/${newGameId}?bot=true`);
  }

  useEffect(() => {
    if (isMobile || !id) return;

    if (connectingRef.current || engineRef.current) return;
    connectingRef.current = true;

    async function loadAndConnect(): Promise<void> {
      const gameId = id!;
      const wsUrl = import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001';

      try {
        // Single API call to get game data + seat reservation
        const data = await getRef.current<{ game: GameData; playerIndex: 0 | 1; seatReservation: SeatReservation | null }>(`/api/games/${gameId}`);
        const { game, playerIndex, seatReservation } = data;
        const storedToken = localStorage.getItem(reconnectStorageKey(gameId));

        setGameData(game);

        if (game.status === 'COMPLETED' && game.winnerId && game.opponent) {
          clearReconnectToken(gameId);
          setMyUserId(playerIndex === 0 ? game.creator.id : game.opponent.id);
          setWinnerId(game.winnerId);
          setPhase('ended');
          connectingRef.current = false;
          return;
        }

        if (game.status !== 'IN_PROGRESS' || !game.colyseusRoomId || !game.opponent) {
          clearReconnectToken(gameId);
          connectingRef.current = false;
          setError('Game is not available');
          return;
        }

        if (!canvasRef.current) {
          connectingRef.current = false;
          return;
        }

        setMyUserId(playerIndex === 0 ? game.creator.id : game.opponent.id);
        setPhase('connecting');

        const client = new Client(wsUrl);
        const engine = new GameEngine(canvasRef.current);

        engine.setPhaseChangeCallback((p, wId, rWId) => {
          setPhase(p);
          setWinnerId(wId);
          setRoundWinnerId(rWId);
          if (p === 'ended') {
            clearReconnectToken(gameId);
          }
        });

        // Try reconnect token first, fall back to seat reservation
        let connected = false;
        if (storedToken) {
          try {
            await engine.reconnect(
              client,
              storedToken,
              playerIndex,
              game.creator.username,
              game.opponent.username,
            );
            connected = true;
          } catch {
            clearReconnectToken(gameId);
          }
        }

        if (!connected) {
          if (!seatReservation) {
            connectingRef.current = false;
            setError('Game is not available');
            return;
          }

          await engine.connect(
            client,
            seatReservation,
            playerIndex,
            game.creator.username,
            game.opponent.username,
          );
        }

        // Store reconnection token for tab-close recovery
        const token = engine.getReconnectionToken();
        if (token) {
          storeReconnectToken(gameId, token);
        }

        engineRef.current = engine;
      } catch (err) {
        connectingRef.current = false;
        setError(err instanceof Error ? err.message : 'Failed to connect');
      }
    }

    void loadAndConnect();

    return () => {
      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
        connectingRef.current = false;
      }
    };
  }, [id, isMobile]);

  if (isMobile) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="text-center">
          <p className="text-2xl mb-3">🖥️</p>
          <h1 className="text-lg font-bold text-white mb-2">Desktop Required</h1>
          <p className="text-slate-400 text-sm">
            Tank Battle requires a desktop browser with a keyboard.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    const statusMessages: Record<string, { title: string; subtitle: string }> = {
      COMPLETED: { title: 'Game Finished', subtitle: 'This game has already ended.' },
      FORFEITED: { title: 'Game Forfeited', subtitle: 'This game was forfeited or the server restarted.' },
      EXPIRED: { title: 'Game Expired', subtitle: 'This game invite expired before it was accepted.' },
      REJECTED: { title: 'Invite Declined', subtitle: 'The invite for this game was declined.' },
    };
    const status = gameData?.status ?? '';
    const msg = statusMessages[status];

    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          {msg ? (
            <>
              <p className="text-slate-200 font-semibold text-lg mb-1">{msg.title}</p>
              <p className="text-slate-500 text-sm mb-6">{msg.subtitle}</p>
            </>
          ) : (
            <ErrorAlert message={error} className="mb-6" />
          )}
          <button
            onClick={() => navigate('/')}
            className="bg-cyan-400 text-slate-900 font-semibold px-6 py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors"
          >
            Back to Home
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
      {phase !== 'ended' && phase !== 'loading' && (
        <button
          onClick={() => setShowLeaveModal(true)}
          className="absolute top-4 right-4 border border-slate-700 text-slate-500 hover:border-red-500/50 hover:text-red-400 text-xs px-3 py-1.5 rounded-lg transition-colors z-10"
        >
          Leave Room
        </button>
      )}
      {(phase === 'loading' || phase === 'connecting' || phase === 'waiting') && (
        <div className="absolute text-slate-400 text-sm">
          {phase === 'loading' ? 'Loading game...' : phase === 'connecting' ? 'Connecting...' : 'Waiting for opponent...'}
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
            <p className="text-slate-500 text-xs mt-2">New map incoming...</p>
          </div>
        </div>
      )}
      {phase === 'ended' && gameData && (
        <GameResultsOverlay
          winnerId={winnerId}
          myUserId={myUserId}
          opponentUsername={opponentUsername}
          isBotGame={isBotGame}
          onRetry={handleBotRetry}
        />
      )}
      {showLeaveModal && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-50">
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6 w-80 text-center shadow-2xl">
            <p className="text-white font-semibold mb-2">Leave Room?</p>
            <p className="text-slate-400 text-sm mb-6">
              {phase === 'playing' || phase === 'countdown' || phase === 'resolving'
                ? 'Leaving an active game forfeits the match. Your opponent wins.'
                : 'Are you sure you want to leave?'}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLeaveModal(false)}
                className="flex-1 border border-slate-600 text-slate-300 py-2.5 rounded-lg text-sm font-medium hover:border-slate-500 hover:text-white transition-colors"
              >
                Stay
              </button>
              <button
                onClick={handleLeaveConfirm}
                className="flex-1 bg-red-500/20 border border-red-500/50 text-red-400 hover:bg-red-500/30 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
