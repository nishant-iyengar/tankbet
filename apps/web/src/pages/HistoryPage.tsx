import { useEffect, useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import type { GameHistoryEntry, GameHistoryResponse, GameStatus } from '@tankbet/shared/types';

const STATUS_OPTIONS: Array<{ label: string; value: GameStatus | '' }> = [
  { label: 'All Statuses', value: '' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Forfeited', value: 'FORFEITED' },
  { label: 'Rejected', value: 'REJECTED' },
  { label: 'Pending', value: 'PENDING_ACCEPTANCE' },
  { label: 'In Progress', value: 'IN_PROGRESS' },
];

const RESULT_OPTIONS: Array<{ label: string; value: 'WON' | 'LOST' | '' }> = [
  { label: 'All Results', value: '' },
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

const selectClass =
  'bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400/40 focus:border-cyan-400/50 transition-colors';

export function HistoryPage(): React.JSX.Element {
  const { get } = useApi();
  const [entries, setEntries] = useState<GameHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [statusFilter, setStatusFilter] = useState<GameStatus | ''>('');
  const [resultFilter, setResultFilter] = useState<'WON' | 'LOST' | ''>('');

  const buildParams = useCallback((nextCursor?: string) => {
    const params = new URLSearchParams();
    if (nextCursor) params.set('cursor', nextCursor);
    if (statusFilter) params.set('status', statusFilter);
    if (resultFilter) params.set('result', resultFilter);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [statusFilter, resultFilter]);

  const loadEntries = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    try {
      const result = await get<GameHistoryResponse>(`/api/users/game-history${buildParams(nextCursor)}`);
      if (nextCursor) {
        setEntries((prev) => [...prev, ...result.entries]);
      } else {
        setEntries(result.entries);
      }
      setCursor(result.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [get, buildParams]);

  // Load on mount and when filters change
  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const value = e.target.value;
    const valid = STATUS_OPTIONS.find((o) => o.value === value);
    if (valid) setStatusFilter(valid.value);
  }

  function handleResultChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const value = e.target.value;
    const valid = RESULT_OPTIONS.find((o) => o.value === value);
    if (valid) setResultFilter(valid.value);
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Game History</h1>
        <p className="text-slate-400 text-sm">View your past and current games.</p>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <select
          value={statusFilter}
          onChange={handleStatusChange}
          className={selectClass}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <select
          value={resultFilter}
          onChange={handleResultChange}
          className={selectClass}
        >
          {RESULT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700/50 text-slate-400">
              <th className="text-left px-4 py-3 font-medium">Date</th>
              <th className="text-left px-4 py-3 font-medium">Opponent</th>
              <th className="text-center px-4 py-3 font-medium">Result</th>
              <th className="text-right px-4 py-3 font-medium">Duration</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-slate-800 last:border-0 hover:bg-slate-800/50 transition-colors">
                <td className="px-4 py-3 text-slate-300 tabular-nums">
                  {new Date(entry.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-slate-200 font-medium">
                  {entry.opponentUsername}
                </td>
                <td className="px-4 py-3 text-center">
                  {entry.result === 'WON' && <span className="text-green-400 font-semibold">Won</span>}
                  {entry.result === 'LOST' && <span className="text-red-400 font-semibold">Lost</span>}
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

        {!loading && entries.length === 0 && (
          <p className="text-center text-slate-500 text-sm py-12">
            No games found. Play a game to get started!
          </p>
        )}
      </div>

      {loading && (
        <p className="text-center text-slate-500 text-sm mt-6">Loading...</p>
      )}

      {cursor && !loading && (
        <button
          onClick={() => void loadEntries(cursor)}
          className="w-full mt-4 py-2 text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          Load more
        </button>
      )}
    </div>
  );
}
