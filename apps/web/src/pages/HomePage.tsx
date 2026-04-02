import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { ErrorAlert } from '../components/ErrorAlert';
import type {
  GameHistoryEntry,
  GameHistoryResponse,
  GameStatus,
  UserStats,
} from '@tankbet/shared/types';

interface ActiveGameInfo {
  gameId: string;
  inviteToken: string;
  status: 'PENDING_ACCEPTANCE' | 'IN_PROGRESS';
}

interface UserData {
  username: string;
  activeGame: ActiveGameInfo | null;
}

const HISTORY_PAGE_SIZE = 10;

type QuickFilter = 'ALL' | 'WON' | 'LOST';

const QUICK_FILTERS: Array<{ label: string; value: QuickFilter }> = [
  { label: 'All', value: 'ALL' },
  { label: 'Won', value: 'WON' },
  { label: 'Lost', value: 'LOST' },
];

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function statusLabel(status: GameStatus): string {
  switch (status) {
    case 'COMPLETED': return 'Completed';
    case 'FORFEITED': return 'Forfeited';
    case 'EXPIRED': return 'Expired';
    case 'REJECTED': return 'Rejected';
    case 'PENDING_ACCEPTANCE': return 'Pending';
    case 'IN_PROGRESS': return 'In Progress';
  }
}

function statusColor(status: GameStatus): string {
  switch (status) {
    case 'COMPLETED': return 'text-slate-300';
    case 'IN_PROGRESS': return 'text-cyan-400';
    case 'PENDING_ACCEPTANCE': return 'text-yellow-400';
    case 'FORFEITED': return 'text-orange-400';
    case 'EXPIRED': return 'text-slate-500';
    case 'REJECTED': return 'text-red-400';
  }
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}): React.JSX.Element {
  return (
    <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${color ?? 'text-white'}`}>{value}</p>
    </div>
  );
}

export function HomePage(): React.JSX.Element {
  const { get, post } = useApi();
  const navigate = useNavigate();
  const [user, setUser] = useState<UserData | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // User stats
  const [userStats, setUserStats] = useState<UserStats | null>(null);

  // Game history state
  const [historyEntries, setHistoryEntries] = useState<GameHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined);
  const cursorStackRef = useRef<Array<string | undefined>>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [filter, setFilter] = useState<QuickFilter>('ALL');
  const nextCursorRef = useRef<string | null>(null);

  const refreshUser = useCallback(() => {
    void get<UserData>('/api/users/me').then((userData) => {
      setUser(userData);
      if (userData.activeGame) {
        const skipTs = sessionStorage.getItem('skipActiveGameRedirect');
        if (skipTs && Date.now() - Number(skipTs) < 5000) {
          return;
        }
        sessionStorage.removeItem('skipActiveGameRedirect');
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

  // User stats
  useEffect(() => {
    void get<UserStats>('/api/users/stats').then(setUserStats);
  }, [get]);

  // Game history
  const buildParams = useCallback((cursor?: string) => {
    const params = new URLSearchParams();
    params.set('limit', String(HISTORY_PAGE_SIZE));
    if (cursor) params.set('cursor', cursor);
    if (filter === 'WON' || filter === 'LOST') {
      params.set('status', 'COMPLETED');
      params.set('result', filter);
    }
    return `?${params.toString()}`;
  }, [filter]);

  const loadPage = useCallback(async (cursor?: string) => {
    setHistoryLoading(true);
    try {
      const result = await get<GameHistoryResponse>(`/api/users/game-history${buildParams(cursor)}`);
      setHistoryEntries(result.entries);
      nextCursorRef.current = result.nextCursor;
      setHasNextPage(result.nextCursor !== null);
    } finally {
      setHistoryLoading(false);
    }
  }, [get, buildParams]);

  useEffect(() => {
    cursorStackRef.current = [];
    setCurrentCursor(undefined);
    setPageIndex(0);
    void loadPage();
  }, [loadPage]);

  function goNextPage(): void {
    const nextCursor = nextCursorRef.current;
    if (!nextCursor) return;
    cursorStackRef.current = [...cursorStackRef.current, currentCursor];
    setCurrentCursor(nextCursor);
    setPageIndex((i) => i + 1);
    void loadPage(nextCursor);
  }

  function goPrevPage(): void {
    const stack = cursorStackRef.current;
    if (stack.length === 0) return;
    const prevCursor = stack[stack.length - 1];
    cursorStackRef.current = stack.slice(0, -1);
    setCurrentCursor(prevCursor);
    setPageIndex((i) => i - 1);
    void loadPage(prevCursor);
  }

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

  const rangeStart = pageIndex * HISTORY_PAGE_SIZE + 1;
  const rangeEnd = pageIndex * HISTORY_PAGE_SIZE + historyEntries.length;
  const hasPrev = pageIndex > 0;

  // Compute derived user stats
  const winRate =
    userStats && userStats.wins + userStats.losses > 0
      ? Math.round((userStats.wins / (userStats.wins + userStats.losses)) * 100)
      : null;

  const streakText =
    userStats
      ? userStats.streak > 0
        ? `${userStats.streak}W`
        : userStats.streak < 0
          ? `${Math.abs(userStats.streak)}L`
          : '—'
      : '—';

  const streakColor =
    userStats
      ? userStats.streak > 0
        ? 'text-green-400'
        : userStats.streak < 0
          ? 'text-red-400'
          : 'text-slate-400'
      : 'text-slate-400';

  return (
    <div className="max-w-4xl">
      {/* Hero CTA Card */}
      <div className="bg-slate-900 border border-cyan-400/20 rounded-xl p-8 mb-8 bg-gradient-to-br from-cyan-400/5 to-transparent">
        <h1 className="text-2xl font-bold text-white mb-2">
          Ready for Battle, <span className="text-cyan-400">{user.username}</span>?
        </h1>
        <p className="text-slate-400 text-sm mb-6">Challenge a friend to a 1v1 tank battle.</p>
        {error && <ErrorAlert message={error} className="mb-4" />}
        <button
          onClick={() => void createGame()}
          disabled={creating}
          className="bg-cyan-400 text-slate-900 font-bold px-10 py-3.5 rounded-xl text-base hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none shadow-lg shadow-cyan-400/20"
        >
          {creating ? 'Creating...' : 'Generate Invite Link'}
        </button>
      </div>

      {/* User Stats Row */}
      {userStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <StatCard
            label="Win Rate"
            value={winRate !== null ? `${winRate}%` : '—'}
            color={
              winRate !== null
                ? winRate >= 50
                  ? 'text-green-400'
                  : 'text-red-400'
                : 'text-slate-400'
            }
          />
          <StatCard
            label="Record"
            value={`${userStats.wins}W – ${userStats.losses}L`}
          />
          <StatCard
            label="Streak"
            value={streakText}
            color={streakColor}
          />
          <StatCard
            label="Games Played"
            value={String(userStats.wins + userStats.losses)}
            color="text-cyan-400"
          />
        </div>
      )}

      {/* Game History */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">Game History</h2>
        <div className="flex gap-2">
          {QUICK_FILTERS.map((qf) => (
            <button
              key={qf.value}
              onClick={() => setFilter(qf.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                filter === qf.value
                  ? 'bg-cyan-400/15 border-cyan-400/60 text-cyan-300'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-300'
              }`}
            >
              {qf.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700/50 text-slate-400 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3 font-medium">Date</th>
              <th className="text-left px-4 py-3 font-medium">Opponent</th>
              <th className="text-center px-4 py-3 font-medium">Result</th>
              <th className="text-right px-4 py-3 font-medium">Duration</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {!historyLoading && historyEntries.map((entry) => {
              const borderColor =
                entry.result === 'WON'
                  ? 'border-l-green-400'
                  : entry.result === 'LOST'
                    ? 'border-l-red-400'
                    : 'border-l-transparent';

              return (
                <tr
                  key={entry.id}
                  className={`border-b border-slate-800/50 last:border-b-0 border-l-2 ${borderColor} hover:bg-slate-800/40 transition-colors`}
                >
                  <td className="px-4 py-3 text-slate-300 tabular-nums whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                  <td className="px-4 py-3 text-slate-200 font-medium">
                    {entry.opponentUsername}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {entry.result === 'WON' && (
                      <span className="inline-flex items-center text-green-400 font-semibold text-xs bg-green-400/10 px-2 py-0.5 rounded-full">
                        Won
                      </span>
                    )}
                    {entry.result === 'LOST' && (
                      <span className="inline-flex items-center text-red-400 font-semibold text-xs bg-red-400/10 px-2 py-0.5 rounded-full">
                        Lost
                      </span>
                    )}
                    {entry.result === null && <span className="text-slate-500">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-400">
                    {entry.durationSeconds !== null ? formatDuration(entry.durationSeconds) : '—'}
                  </td>
                  <td className={`px-4 py-3 ${statusColor(entry.status)}`}>
                    {statusLabel(entry.status)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {historyLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin" />
          </div>
        )}

        {!historyLoading && historyEntries.length === 0 && (
          <p className="text-center text-slate-500 text-sm py-12">
            No games found. Play a game to get started!
          </p>
        )}

        {!historyLoading && historyEntries.length > 0 && (
          <div className="flex items-center justify-end gap-4 px-4 py-2.5 border-t border-slate-700/50 text-xs text-slate-400">
            <span className="tabular-nums">
              {rangeStart}–{rangeEnd}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={goPrevPage}
                disabled={!hasPrev}
                className="p-1.5 rounded-md hover:bg-slate-800 disabled:opacity-30 disabled:cursor-default transition-colors"
                aria-label="Previous page"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
                </svg>
              </button>
              <button
                onClick={goNextPage}
                disabled={!hasNextPage}
                className="p-1.5 rounded-md hover:bg-slate-800 disabled:opacity-30 disabled:cursor-default transition-colors"
                aria-label="Next page"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
