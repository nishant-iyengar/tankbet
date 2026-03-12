import { useEffect, useState, useCallback, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import type { GameHistoryEntry, GameHistoryResponse, GameStatus } from '@tankbet/shared/types';

const PAGE_SIZE = 20;

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

export function HistoryPage(): React.JSX.Element {
  const { get } = useApi();
  const [entries, setEntries] = useState<GameHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasNextPage, setHasNextPage] = useState(false);

  // Pagination: track cursor for next page + a stack of cursors for previous pages
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined);
  const cursorStackRef = useRef<Array<string | undefined>>([]);
  const [pageIndex, setPageIndex] = useState(0);

  // Single flattened filter
  const [filter, setFilter] = useState<QuickFilter>('ALL');
  const nextCursorRef = useRef<string | null>(null);

  const buildParams = useCallback((cursor?: string) => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (cursor) params.set('cursor', cursor);
    if (filter === 'WON' || filter === 'LOST') {
      params.set('status', 'COMPLETED');
      params.set('result', filter);
    }
    return `?${params.toString()}`;
  }, [filter]);

  const loadPage = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const result = await get<GameHistoryResponse>(`/api/users/game-history${buildParams(cursor)}`);
      setEntries(result.entries);
      nextCursorRef.current = result.nextCursor;
      setHasNextPage(result.nextCursor !== null);
    } finally {
      setLoading(false);
    }
  }, [get, buildParams]);

  // Reset to first page when filter changes
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

  const rangeStart = pageIndex * PAGE_SIZE + 1;
  const rangeEnd = pageIndex * PAGE_SIZE + entries.length;
  const hasPrev = pageIndex > 0;

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Game History</h1>
        <p className="text-slate-400 text-sm">View your past and current games.</p>
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 mb-5">
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

      {/* Table */}
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
            {!loading && entries.map((entry, i) => (
              <tr
                key={entry.id}
                className={`border-b border-slate-800/50 last:border-0 hover:bg-slate-800/40 transition-colors ${
                  i % 2 === 1 ? 'bg-slate-800/20' : ''
                }`}
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
            ))}
          </tbody>
        </table>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin" />
          </div>
        )}

        {/* Empty state */}
        {!loading && entries.length === 0 && (
          <p className="text-center text-slate-500 text-sm py-12">
            No games found. Play a game to get started!
          </p>
        )}

        {/* Pagination footer */}
        {!loading && entries.length > 0 && (
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
