import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAppAuth, useAppUser } from '../auth/useAppAuth';
import { useApi } from '../hooks/useApi';
import { apiFetch } from '../api/client';
import { formatTime } from '@tankbet/shared/utils';
import type { GameInvitePreview } from '@tankbet/shared/types';
import { ErrorAlert } from '../components/ErrorAlert';

function HomeButton({ className = '' }: { className?: string }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate('/')}
      className={`w-full border border-slate-600 text-slate-300 hover:border-slate-400 hover:text-white rounded-lg text-sm font-medium py-2.5 transition-colors ${className}`}
    >
      Go Home
    </button>
  );
}

export function InvitePage(): React.JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const isCreator = searchParams.get('creator') === 'true';
  const { isSignedIn } = useAppAuth();
  const { user } = useAppUser();
  const { post } = useApi();
  const navigate = useNavigate();

  const inviteLink = token ? `${window.location.origin}/invite/${token}` : '';
  const [copied, setCopied] = useState(false);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  }, [inviteLink]);

  const [invite, setInvite] = useState<GameInvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [cancellingInvite, setCancellingInvite] = useState(false);
  const [error, setError] = useState('');
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    const fetchInvite = async (): Promise<void> => {
      try {
        const data = await apiFetch<GameInvitePreview>(`/api/games/invite/${token}`);
        if (cancelled) return;

        // If the game is already in progress, redirect to the game page
        if (data.status === 'IN_PROGRESS') {
          navigate(`/game/${data.id}`);
          return;
        }

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

    return () => { cancelled = true; };
  }, [token, navigate]);

  useEffect(() => {
    if (timeLeft <= 0) return;
    const interval = setInterval(() => {
      setTimeLeft((t) => Math.max(0, t - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [timeLeft]);

  // Creator view: SSE stream to detect when opponent accepts/rejects/cancels
  useEffect(() => {
    if (!token || !isCreator || !invite || invite.status !== 'PENDING_ACCEPTANCE') return;

    const API_URL: string = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001';
    const es = new EventSource(`${API_URL}/api/games/invite/${token}/events`);

    es.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { event: string; gameId?: string };
      if (data.event === 'accepted' && data.gameId) {
        navigate(`/game/${data.gameId}`);
      } else if (data.event === 'rejected' || data.event === 'cancelled') {
        setInvite((prev) => prev ? { ...prev, status: data.event === 'rejected' ? 'REJECTED' : 'EXPIRED' } : prev);
      }
    };

    return () => { es.close(); };
  }, [token, isCreator, invite, navigate]);

  async function handleAccept(): Promise<void> {
    if (!token) return;

    if (!isSignedIn) {
      navigate(`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`);
      return;
    }

    setAccepting(true);
    setError('');
    try {
      await post('/api/users/onboard', {});
      const result = await post<{ gameId: string }>(`/api/games/invite/${token}/accept`, {});
      navigate(`/game/${result.gameId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invite');
    } finally {
      setAccepting(false);
    }
  }

  async function handleCancelInvite(): Promise<void> {
    if (!token) return;
    setCancellingInvite(true);
    try {
      await post(`/api/games/invite/${token}/cancel`);
      navigate('/');
    } catch {
      setCancellingInvite(false);
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
        <p className="text-slate-500 text-sm">Loading invite...</p>
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
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-slate-400 text-sm">{message}</p>
        <HomeButton className="w-auto px-6" />
      </div>
    );
  }

  if (isCreator) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-8 w-full max-w-sm text-center">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Waiting for opponent</p>
          <div className={`text-4xl font-bold tabular-nums my-4 ${timeLeft <= 0 ? 'text-red-400' : 'text-white'}`}>
            {timeLeft <= 0 ? 'Link Expired' : formatTime(timeLeft)}
          </div>
          <p className="text-xs text-slate-500 mb-3">Share the invite link with your opponent.</p>
          <div className="flex items-center bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
            <span className="flex-1 px-3 py-2.5 text-xs text-slate-400 truncate select-all font-mono">
              {inviteLink}
            </span>
            <button
              onClick={handleCopyLink}
              className="px-3 py-2.5 border-l border-slate-700 text-slate-400 hover:text-cyan-400 hover:bg-slate-700/50 transition-colors shrink-0"
              title="Copy link"
            >
              {copied ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
          {timeLeft <= 0 ? (
            <HomeButton className="mt-4" />
          ) : (
            <button
              onClick={() => void handleCancelInvite()}
              disabled={cancellingInvite}
              className="mt-4 w-full border border-slate-700 text-slate-500 hover:border-red-500/50 hover:text-red-400 text-xs font-medium py-2 rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              {cancellingInvite ? 'Cancelling...' : 'Cancel Invite'}
            </button>
          )}
        </div>
      </div>
    );
  }

  const isOwnInvite = isSignedIn && user?.username === invite.creatorUsername;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6 w-full max-w-sm">
        <h1 className="text-lg font-bold text-white mb-1">
          {invite.creatorUsername} wants to play
        </h1>
        <div className="flex items-center gap-3 mb-5">
          <span className={`text-sm tabular-nums font-medium ${timeLeft <= 0 ? 'text-red-400' : timeLeft <= 30 ? 'text-red-400' : 'text-slate-400'}`}>
            {timeLeft <= 0 ? 'Link Expired' : formatTime(timeLeft)}
          </span>
        </div>

        {timeLeft <= 0 && (
          <p className="text-red-400 text-sm mb-4">This invite has expired.</p>
        )}

        {isOwnInvite && (
          <div className="flex items-start gap-2.5 bg-amber-400/10 border border-amber-400/30 rounded-lg px-3 py-2.5 mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p className="text-amber-300 text-sm">This is your own invite. Share the link with your opponent to play.</p>
          </div>
        )}

        {error && <ErrorAlert message={error} className="mb-3" />}

        {timeLeft <= 0 ? (
          <HomeButton />
        ) : isOwnInvite ? (
          <HomeButton />
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => void handleAccept()}
              disabled={accepting}
              className="flex-1 bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              {accepting ? 'Accepting...' : 'Accept'}
            </button>
            <button
              onClick={() => void handleReject()}
              className="flex-1 border border-slate-600 text-slate-300 py-2.5 rounded-lg text-sm font-medium hover:border-slate-500 hover:text-white transition-colors"
            >
              Decline
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
