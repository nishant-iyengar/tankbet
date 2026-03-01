import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { useApi } from '../hooks/useApi';
import { apiFetch } from '../api/client';
import { formatCents, formatTime } from '@tankbet/shared/utils';
import { BETA_MODE } from '../config';
import type { GameInvitePreview, PublicCharity } from '@tankbet/shared/types';

export function InvitePage(): React.JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const isCreator = searchParams.get('creator') === 'true';
  const { isSignedIn } = useAuth();
  const { get, post } = useApi();
  const navigate = useNavigate();

  const [invite, setInvite] = useState<GameInvitePreview | null>(null);
  const [charities, setCharities] = useState<PublicCharity[]>([]);
  const [selectedCharity, setSelectedCharity] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState('');
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    const fetchInvite = async (): Promise<void> => {
      try {
        const data = await apiFetch<GameInvitePreview>(`/api/games/invite/${token}`);
        if (cancelled) return;
        setInvite(data);
        const expiresAt = new Date(data.inviteExpiresAt).getTime();
        setTimeLeft(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)));
      } catch {
        if (!cancelled) setError('Failed to load invite');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchInvite();
    void get<{ charities: PublicCharity[] }>('/api/charities')
      .then((r) => { if (!cancelled) setCharities(r.charities); })
      .catch(() => { /* non-critical */ });

    return () => { cancelled = true; };
  }, [token, get]);

  useEffect(() => {
    if (timeLeft <= 0) return;
    const interval = setInterval(() => {
      setTimeLeft((t) => Math.max(0, t - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [timeLeft]);

  async function handleAccept(): Promise<void> {
    if (!token || (!BETA_MODE && !selectedCharity)) return;

    if (!isSignedIn) {
      navigate('/login');
      return;
    }

    setAccepting(true);
    setError('');
    try {
      const result = await post<{ gameId: string }>(`/api/games/invite/${token}/accept`, {
        charityId: BETA_MODE ? null : selectedCharity,
      });
      navigate(`/game/${result.gameId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invite');
    } finally {
      setAccepting(false);
    }
  }

  async function handleReject(): Promise<void> {
    if (!token) return;
    try {
      await post(`/api/games/invite/${token}/reject`);
      navigate('/');
    } catch {
      navigate('/');
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-slate-500 text-sm">Loading invite…</p>
      </div>
    );
  }

  if (!invite || invite.status !== 'PENDING_ACCEPTANCE') {
    const message =
      invite?.status === 'EXPIRED' || invite?.status === 'REJECTED'
        ? 'This invite is no longer valid.'
        : invite?.status === 'IN_PROGRESS'
          ? 'This game has already started.'
          : 'Invite not found.';

    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-slate-400 text-sm">{message}</p>
      </div>
    );
  }

  if (isCreator) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-8 w-full max-w-sm text-center">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Waiting for opponent</p>
          <div className="text-4xl font-bold tabular-nums text-white my-4">
            {formatTime(timeLeft)}
          </div>
          {!BETA_MODE && (
            <p className="text-sm text-slate-400 mb-1">
              Bet: <span className="text-white font-medium tabular-nums">{formatCents(invite.betAmountCents)}</span>
            </p>
          )}
          <p className="text-xs text-slate-500 mb-6">Share the invite link with your opponent.</p>
          <button
            onClick={() => void navigator.clipboard.writeText(window.location.href.replace('?creator=true', ''))}
            className="bg-cyan-400 text-slate-900 font-semibold text-sm px-5 py-2.5 rounded-lg hover:bg-cyan-300 transition-colors"
          >
            Copy Link
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6 w-full max-w-sm">
        <h1 className="text-lg font-bold text-white mb-1">
          {invite.creatorUsername} wants to play
        </h1>
        <div className="flex items-center gap-3 mb-5">
          {!BETA_MODE && (
            <span className="text-sm text-slate-400">
              Bet: <span className="text-white font-medium tabular-nums">{formatCents(invite.betAmountCents)}</span>
            </span>
          )}
          <span className="text-slate-600">·</span>
          <span className={`text-sm tabular-nums font-medium ${timeLeft <= 30 ? 'text-red-400' : 'text-slate-400'}`}>
            {formatTime(timeLeft)}
          </span>
        </div>

        {timeLeft <= 0 && (
          <p className="text-red-400 text-sm mb-4">This invite has expired.</p>
        )}

        {!BETA_MODE && (
          <>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Your Charity</p>
            <div className="grid grid-cols-2 gap-2 mb-5 max-h-52 overflow-y-auto">
              {charities.map((charity) => (
                <button
                  key={charity.id}
                  onClick={() => setSelectedCharity(charity.id)}
                  className={`p-2.5 rounded-lg border text-left text-xs transition-colors ${
                    selectedCharity === charity.id
                      ? 'bg-cyan-400/10 border-cyan-400/60 text-cyan-300'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  {charity.name}
                </button>
              ))}
            </div>
          </>
        )}

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={() => void handleAccept()}
            disabled={accepting || (!BETA_MODE && !selectedCharity) || timeLeft <= 0}
            className="flex-1 bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            {accepting ? 'Accepting…' : 'Accept'}
          </button>
          <button
            onClick={() => void handleReject()}
            className="flex-1 border border-slate-600 text-slate-300 py-2.5 rounded-lg text-sm font-medium hover:border-slate-500 hover:text-white transition-colors"
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}
