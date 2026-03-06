import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { ErrorAlert } from '../components/ErrorAlert';

interface ActiveGameInfo {
  gameId: string;
  inviteToken: string;
  status: 'PENDING_ACCEPTANCE' | 'IN_PROGRESS';
}

interface UserData {
  username: string;
  activeGame: ActiveGameInfo | null;
}

export function HomePage(): React.JSX.Element {
  const { get, post } = useApi();
  const navigate = useNavigate();
  const [user, setUser] = useState<UserData | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const refreshUser = useCallback(() => {
    void get<UserData>('/api/users/me').then((userData) => {
      setUser(userData);
      if (userData.activeGame) {
        if (userData.activeGame.status === 'PENDING_ACCEPTANCE') {
          navigate(`/invite/${userData.activeGame.inviteToken}?creator=true`);
        } else {
          navigate(`/game/${userData.activeGame.gameId}`);
        }
      }
    });
  }, [get, navigate]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  async function createGame(): Promise<void> {
    setCreating(true);
    setError('');
    try {
      const result = await post<{ inviteToken: string }>('/api/games/create', {});
      navigate(`/invite/${result.inviteToken}?creator=true`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game');
    } finally {
      setCreating(false);
    }
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-slate-500 text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      {/* Hero + CTA */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-10">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Welcome, <span className="text-cyan-400">{user.username}</span>
          </h1>
          <p className="text-slate-500 text-sm mt-1">Challenge a friend to a 1v1 tank battle.</p>
        </div>
        <div className="shrink-0">
          {error && <ErrorAlert message={error} className="mb-2" />}
          <button
            onClick={() => void createGame()}
            disabled={creating}
            className="bg-cyan-400 text-slate-900 font-semibold px-6 py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            {creating ? 'Creating...' : 'Generate Invite Link'}
          </button>
        </div>
      </div>

      {/* How to Play */}
      <h2 className="text-lg font-bold text-white mb-4">How to Play</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Objective */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <h3 className="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-3">Objective</h3>
          <p className="text-slate-300 text-sm leading-relaxed">
            Eliminate your opponent by depleting all 5 of their lives. Each hit removes one life.
          </p>
        </div>

        {/* Controls */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <h3 className="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-3">Controls</h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Move</span>
              <kbd className="bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded text-xs font-mono">Arrow Keys</kbd>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Fire</span>
              <kbd className="bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded text-xs font-mono">Space</kbd>
            </div>
          </div>
        </div>

        {/* Bullets */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <h3 className="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-3">Bullets</h3>
          <ul className="space-y-1.5 text-sm text-slate-300">
            <li className="flex items-start gap-2">
              <span className="text-slate-600 mt-0.5">&#8226;</span>
              Up to 10 bullets active at once
            </li>
            <li className="flex items-start gap-2">
              <span className="text-slate-600 mt-0.5">&#8226;</span>
              Each bullet lasts 8 seconds
            </li>
            <li className="flex items-start gap-2">
              <span className="text-slate-600 mt-0.5">&#8226;</span>
              Bullets ricochet off walls indefinitely
            </li>
            <li className="flex items-start gap-2">
              <span className="text-slate-600 mt-0.5">&#8226;</span>
              Watch out — your own bullets can hit you
            </li>
          </ul>
        </div>

        {/* Disconnection */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <h3 className="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-3">Disconnection</h3>
          <p className="text-slate-300 text-sm leading-relaxed">
            If you disconnect during a game, you have 30 seconds to reconnect. After that, the game
            is forfeited and your opponent wins.
          </p>
        </div>
      </div>
    </div>
  );
}
