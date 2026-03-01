import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { formatCents } from '@tankbet/shared/utils';
import { BET_AMOUNTS_CENTS } from '@tankbet/game-engine/constants';
import { BankSetupModal } from '../components/BankSetupModal';
import { BETA_MODE } from '../config';
import type { BetAmountCents, PublicCharity } from '@tankbet/shared/types';

interface ActiveGameInfo {
  gameId: string;
  inviteToken: string;
  status: 'PENDING_ACCEPTANCE' | 'IN_PROGRESS';
}

interface UserData {
  username: string;
  balance: number;
  hasBankAccount: boolean;
  activeGame: ActiveGameInfo | null;
}

export function HomePage(): React.JSX.Element {
  const { get, post } = useApi();
  const navigate = useNavigate();
  const [user, setUser] = useState<UserData | null>(null);
  const [charities, setCharities] = useState<PublicCharity[]>([]);
  const [selectedBet, setSelectedBet] = useState<BetAmountCents>(200);
  const [selectedCharity, setSelectedCharity] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [showBankModal, setShowBankModal] = useState(false);

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
    void get<{ charities: PublicCharity[] }>('/api/charities').then((r) => setCharities(r.charities));
  }, [get, refreshUser]);

  async function createGame(): Promise<void> {
    if (!BETA_MODE && !selectedCharity) {
      setError('Please select a charity');
      return;
    }

    setCreating(true);
    setError('');
    try {
      const result = await post<{ inviteToken: string }>('/api/games/create', {
        betAmountCents: BETA_MODE ? 0 : selectedBet,
        charityId: BETA_MODE ? null : selectedCharity,
      });
      navigate(`/invite/${result.inviteToken}?creator=true`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game');
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateGame(): Promise<void> {
    if (!BETA_MODE && !user?.hasBankAccount) {
      setShowBankModal(true);
      return;
    }
    await createGame();
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-slate-500 text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">
          Welcome, <span className="text-cyan-400">{user.username}</span>
        </h1>
        <p className="text-slate-500 text-sm mt-1">Challenge a friend and donate to charity.</p>
      </div>

      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6">
        <h2 className="text-base font-semibold text-white mb-1">New Game</h2>
        {BETA_MODE && <p className="text-xs text-slate-500 mb-5">Preview mode — betting disabled</p>}
        {!BETA_MODE && <div className="mb-5" />}

        {/* Bet chip selector */}
        <div className={BETA_MODE ? 'opacity-40 pointer-events-none' : ''}>
          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Bet Amount</p>
            {BETA_MODE && <span className="text-xs text-slate-600 normal-case tracking-normal">Disabled in beta</span>}
          </div>
          <div className="flex gap-2 mb-5">
            {BET_AMOUNTS_CENTS.map((amount) => (
              <button
                key={amount}
                onClick={() => setSelectedBet(amount)}
                className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors tabular-nums ${
                  selectedBet === amount
                    ? 'bg-cyan-400/15 border-cyan-400/60 text-cyan-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-300'
                }`}
              >
                {formatCents(amount)}
              </button>
            ))}
          </div>
        </div>

        {/* Charity picker */}
        <div className={BETA_MODE ? 'opacity-40 pointer-events-none' : ''}>
          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Your Charity</p>
            {BETA_MODE && <span className="text-xs text-slate-600 normal-case tracking-normal">Disabled in beta</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 mb-5">
            {charities.map((charity) => (
              <button
                key={charity.id}
                onClick={() => setSelectedCharity(charity.id)}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  selectedCharity === charity.id
                    ? 'bg-cyan-400/10 border-cyan-400/60'
                    : 'bg-slate-800 border-slate-700 hover:border-slate-600'
                }`}
              >
                <span className={`block text-sm font-medium ${
                  selectedCharity === charity.id ? 'text-cyan-300' : 'text-slate-300'
                }`}>
                  {charity.name}
                </span>
                <span className="block text-xs text-slate-500 mt-0.5">{charity.description}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        <button
          onClick={() => void handleCreateGame()}
          disabled={creating || (!BETA_MODE && !selectedCharity)}
          className="w-full bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          {creating ? 'Creating…' : 'Generate Invite Link'}
        </button>
      </div>

      {showBankModal && (
        <BankSetupModal
          onSuccess={() => {
            setShowBankModal(false);
            refreshUser();
            void createGame();
          }}
          onClose={() => setShowBankModal(false)}
        />
      )}

    </div>
  );
}
