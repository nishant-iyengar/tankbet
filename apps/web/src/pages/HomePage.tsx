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
    <div className="max-w-xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">
          Welcome, <span className="text-cyan-400">{user.username}</span>
        </h1>
        <p className="text-slate-500 text-sm mt-1">Challenge a friend to a 1v1 tank battle.</p>
      </div>

      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6">
        <h2 className="text-base font-semibold text-white mb-5">New Game</h2>

        {error && <ErrorAlert message={error} className="mb-3" />}

        <button
          onClick={() => void createGame()}
          disabled={creating}
          className="w-full bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          {creating ? 'Creating...' : 'Generate Invite Link'}
        </button>
      </div>

      <div className="mt-8 space-y-6">
        <h2 className="text-lg font-bold text-white">How to Play</h2>

        <section>
          <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Objective</h3>
          <p className="text-slate-300 text-sm leading-relaxed">
            Eliminate your opponent by depleting all 5 of their lives. Each hit removes one life.
          </p>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Controls</h3>
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-4">
            <ul className="text-sm text-slate-300 space-y-2">
              <li className="flex gap-3">
                <span className="text-slate-500 w-16 shrink-0">Move</span>
                <span>Arrow Keys</span>
              </li>
              <li className="flex gap-3">
                <span className="text-slate-500 w-16 shrink-0">Fire</span>
                <span>Space</span>
              </li>
            </ul>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Bullets</h3>
          <ul className="space-y-2">
            {[
              'Each bullet lasts 3 seconds',
              'Bullets bounce off walls infinitely',
              'Maximum 5 bullets active per player',
              'You can be hit by your own bullets',
            ].map((rule) => (
              <li key={rule} className="flex items-start gap-2 text-sm text-slate-300">
                <span className="text-cyan-400 mt-0.5">–</span>
                {rule}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Disconnection</h3>
          <p className="text-slate-300 text-sm leading-relaxed">
            If you disconnect during a game, you have 30 seconds to reconnect. After that, the game
            is forfeited and your opponent wins.
          </p>
        </section>
      </div>
    </div>
  );
}
