import { useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Client } from '@colyseus/sdk';
import { DevAuthContext, type DevUser } from '../auth/DevAuthContext';
import { apiFetch } from '../api/client';
import { ErrorAlert } from '../components/ErrorAlert';
import { BotPlayer } from '../game/BotPlayer';
import type { SeatReservation } from '../game/GameEngine';

interface DevUserResponse {
  id: string;
  clerkId: string;
  username: string;
  phoneNumber: string;
}

interface DevUsersResponse {
  users: DevUserResponse[];
}

interface GameData {
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

const DEV_CLERK_IDS = ['dev-admin-1', 'dev-admin-2'];

export function DevGamePage(): React.JSX.Element {
  const navigate = useNavigate();
  const devAuth = useContext(DevAuthContext);
  const [devUsers, setDevUsers] = useState<DevUserResponse[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingGame, setLoadingGame] = useState(false);
  const [error, setError] = useState('');
  const [gameLink, setGameLink] = useState('');
  const [gameId, setGameId] = useState('');
  const [botStatus, setBotStatus] = useState<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle');
  const botRef = useRef<BotPlayer | null>(null);

  const currentUser = devAuth?.devUser ?? null;

  // Clean up bot on unmount — but only if we're NOT navigating to the game
  // (navigatedToGame means the bot should stay alive as the opponent)
  const navigatedToGameRef = useRef(false);
  useEffect(() => {
    return () => {
      if (!navigatedToGameRef.current) {
        botRef.current?.disconnect();
      }
    };
  }, []);

  async function fetchDevUsers(): Promise<void> {
    if (devUsers.length > 0) return;
    setLoadingUsers(true);
    try {
      const data = await apiFetch<DevUsersResponse>('/api/dev/users');
      setDevUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dev users');
    } finally {
      setLoadingUsers(false);
    }
  }

  async function loginAs(clerkId: string): Promise<void> {
    setError('');
    try {
      const data = await apiFetch<{ user: DevUserResponse }>('/api/dev/login', {
        method: 'POST',
        body: { clerkId },
      });
      const user: DevUser = {
        id: data.user.id,
        clerkId: data.user.clerkId,
        username: data.user.username,
        phoneNumber: data.user.phoneNumber,
      };
      devAuth?.setDevUser(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  async function createTestGame(): Promise<void> {
    if (!currentUser) return;
    setLoadingGame(true);
    setError('');
    setGameLink('');
    setGameId('');
    setBotStatus('idle');

    // Disconnect any existing bot
    botRef.current?.disconnect();
    botRef.current = null;

    try {
      // The opponent is whichever dev user we're NOT logged in as
      const opponentClerkId = DEV_CLERK_IDS.find((id) => id !== currentUser.clerkId);
      if (!opponentClerkId) {
        setError('No opponent available');
        return;
      }

      const token = `DevToken ${currentUser.clerkId}`;
      const data = await apiFetch<{ gameId: string }>('/api/dev/test-game', {
        method: 'POST',
        body: { opponentClerkId },
        token,
      });
      setGameLink(`${window.location.origin}/game/${data.gameId}`);
      setGameId(data.gameId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create test game');
    } finally {
      setLoadingGame(false);
    }
  }

  async function launchBot(): Promise<void> {
    if (!currentUser || !gameId) return;
    setError('');
    setBotStatus('connecting');

    // Disconnect any existing bot
    botRef.current?.disconnect();

    try {
      // The opponent is whichever dev user we're NOT logged in as
      const opponentClerkId = DEV_CLERK_IDS.find((id) => id !== currentUser.clerkId);
      if (!opponentClerkId) {
        setError('No opponent clerkId found');
        setBotStatus('idle');
        return;
      }

      // Fetch seat reservation as the opponent
      const opponentToken = `DevToken ${opponentClerkId}`;
      const data = await apiFetch<GameData>(`/api/games/${gameId}`, {
        token: opponentToken,
      });

      if (!data.seatReservation) {
        setError('No seat reservation available for bot');
        setBotStatus('idle');
        return;
      }

      const wsUrl = import.meta.env['VITE_WS_URL'] ?? 'ws://localhost:3001';
      const client = new Client(wsUrl);
      const bot = new BotPlayer();

      bot.setStatusCallback((status) => {
        if (status === 'connected') {
          setBotStatus('connected');
        } else if (status === 'disconnected') {
          setBotStatus('disconnected');
        }
      });

      await bot.connect(client, data.seatReservation);
      botRef.current = bot;

      // Auto-navigate to the game as player 1
      navigatedToGameRef.current = true;
      navigate(`/game/${gameId}?bot=true`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to launch bot');
      setBotStatus('idle');
    }
  }

  // Fetch dev users on first render
  if (devUsers.length === 0 && !loadingUsers) {
    void fetchDevUsers();
  }

  const botStatusLabel: Record<typeof botStatus, string> = {
    idle: '',
    connecting: 'Connecting bot...',
    connected: 'Bot connected',
    disconnected: 'Bot disconnected',
  };

  const botStatusColor: Record<typeof botStatus, string> = {
    idle: '',
    connecting: 'text-yellow-400',
    connected: 'text-green-400',
    disconnected: 'text-slate-500',
  };

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center">
      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-8 w-full max-w-lg">
        <p className="text-xs text-cyan-400 font-mono uppercase tracking-widest mb-4">
          Dev · Test Game
        </p>
        <h1 className="text-white text-lg font-bold mb-1">2-Player Dev Game</h1>
        <p className="text-slate-400 text-sm mb-6">
          Log in as a dev user, create a game, then launch a bot or open the link in an incognito
          window.
        </p>

        {error && <ErrorAlert message={error} className="mb-4" />}

        {/* Dev user cards */}
        <div className="space-y-2 mb-6">
          {devUsers.map((user) => {
            const isActive = currentUser?.clerkId === user.clerkId;
            return (
              <div
                key={user.clerkId}
                className={`flex items-center justify-between rounded-lg p-3 border ${
                  isActive
                    ? 'border-cyan-400/50 bg-cyan-400/5'
                    : 'border-slate-700 bg-slate-800'
                }`}
              >
                <div>
                  <p className="text-slate-200 text-sm font-medium">{user.username}</p>
                  <p className="text-slate-500 text-xs font-mono">{user.clerkId}</p>
                </div>
                {isActive ? (
                  <span className="text-cyan-400 text-xs font-medium">Logged in</span>
                ) : (
                  <button
                    onClick={() => void loginAs(user.clerkId)}
                    className="border border-slate-600 text-slate-300 hover:border-cyan-400/50 hover:text-cyan-300 rounded px-3 py-1.5 text-xs font-medium transition-colors"
                  >
                    Login as
                  </button>
                )}
              </div>
            );
          })}
          {loadingUsers && (
            <p className="text-slate-500 text-xs">Loading dev users...</p>
          )}
        </div>

        {/* Create game */}
        {currentUser && (
          <button
            onClick={() => void createTestGame()}
            disabled={loadingGame}
            className="w-full bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg hover:bg-cyan-300 transition-colors text-sm disabled:opacity-40 disabled:pointer-events-none"
          >
            {loadingGame ? 'Creating game...' : 'Create Test Game'}
          </button>
        )}

        {/* Game link + bot controls */}
        {gameLink && (
          <div className="mt-6 bg-slate-800 rounded-lg p-4 space-y-3">
            <p className="text-slate-200 text-sm font-medium">Game created!</p>
            <div className="flex items-center gap-2">
              <p className="text-cyan-400 text-xs font-mono truncate flex-1">{gameLink}</p>
              <a
                href={gameLink}
                className="shrink-0 bg-cyan-400 text-slate-900 font-semibold rounded px-3 py-1.5 text-xs hover:bg-cyan-300 transition-colors"
              >
                Open
              </a>
            </div>

            {/* Bot controls */}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={() => void launchBot()}
                disabled={botStatus === 'connecting' || botStatus === 'connected'}
                className="border border-slate-600 text-slate-300 hover:border-cyan-400/50 hover:text-cyan-300 rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                {botStatus === 'connected' ? 'Bot Running' : 'Launch Bot'}
              </button>
              {botStatus === 'connected' && (
                <button
                  onClick={() => {
                    botRef.current?.disconnect();
                    botRef.current = null;
                  }}
                  className="border border-red-500/50 text-red-400 hover:border-red-400 hover:text-red-300 rounded px-3 py-1.5 text-xs font-medium transition-colors"
                >
                  Stop Bot
                </button>
              )}
              {botStatus !== 'idle' && (
                <span className={`text-xs font-medium ${botStatusColor[botStatus]}`}>
                  {botStatusLabel[botStatus]}
                </span>
              )}
            </div>

            <p className="text-slate-500 text-xs">
              Launch a bot as the opponent, or open this link in an incognito window to play
              manually.
            </p>
          </div>
        )}

        {/* Instructions */}
        {!currentUser && !loadingUsers && devUsers.length > 0 && (
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/30">
            <p className="text-slate-400 text-xs leading-relaxed">
              Click "Login as" on one of the dev users above to get started.
              Then create a test game and share the link with the other player window.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
