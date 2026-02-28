import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { formatCents } from '@tankbet/shared/utils';
import type { DonationHistoryEntry } from '@tankbet/shared/types';

interface DonationResponse {
  entries: DonationHistoryEntry[];
  nextCursor: string | null;
}

export function DonationsPage(): React.JSX.Element {
  const { get } = useApi();
  const [entries, setEntries] = useState<DonationHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [totalDonated, setTotalDonated] = useState(0);

  useEffect(() => {
    void loadEntries();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  async function loadEntries(nextCursor?: string): Promise<void> {
    setLoading(true);
    try {
      const params = nextCursor ? `?cursor=${nextCursor}` : '';
      const result = await get<DonationResponse>(`/api/users/donation-history${params}`);
      setEntries((prev) => [...prev, ...result.entries]);
      setCursor(result.nextCursor);

      setTotalDonated((prev) => prev + result.entries.reduce((sum, e) => sum + e.displayAmountCents, 0));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Donation History</h1>
        <p className="text-slate-400">
          Total donated:{' '}
          <span className="text-white font-semibold tabular-nums">{formatCents(totalDonated)}</span>
        </p>
      </div>

      <div className="space-y-2">
        {entries.map((entry) => (
          <div
            key={`${entry.gameId}-${entry.role}`}
            className="bg-slate-900 border border-slate-700/50 rounded-xl p-4 flex items-center justify-between"
          >
            <div>
              <span className={`text-sm font-semibold ${
                entry.role === 'WINNER' ? 'text-green-400' : 'text-red-400'
              }`}>
                {entry.role === 'WINNER' ? 'Won' : 'Lost'}
              </span>
              <span className="text-sm text-slate-500 ml-2">
                {new Date(entry.createdAt).toLocaleDateString()}
              </span>
            </div>
            <div className="text-right">
              <span className="text-sm font-semibold text-white tabular-nums">
                {formatCents(entry.displayAmountCents)}
              </span>
              <span className="block text-xs text-slate-500 mt-0.5">{entry.charityName}</span>
            </div>
          </div>
        ))}
      </div>

      {loading && (
        <p className="text-center text-slate-500 text-sm mt-6">Loading…</p>
      )}

      {cursor && !loading && (
        <button
          onClick={() => void loadEntries(cursor)}
          className="w-full mt-4 py-2 text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          Load more
        </button>
      )}

      {!loading && entries.length === 0 && (
        <p className="text-center text-slate-500 text-sm mt-10">
          No donations yet. Play a game to get started!
        </p>
      )}
    </div>
  );
}
