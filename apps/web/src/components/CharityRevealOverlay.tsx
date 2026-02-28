import { formatCents } from '@tankbet/shared/utils';
import type { PublicCharity } from '@tankbet/shared/types';

interface CharityRevealOverlayProps {
  didWin: boolean;
  yourCharity: PublicCharity;
  opponentCharity: PublicCharity;
  totalDonatedCents: number;
  betAmountCents: number;
  onPlayAgain: () => void;
}

export function CharityRevealOverlay({
  didWin,
  yourCharity,
  opponentCharity,
  totalDonatedCents,
  betAmountCents,
  onPlayAgain,
}: CharityRevealOverlayProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 max-w-md w-full text-center">
        <h1 className={`text-3xl font-bold mb-1 ${didWin ? 'text-green-400' : 'text-red-400'}`}>
          {didWin ? 'YOU WON' : 'YOU LOST'}
        </h1>
        <p className="text-slate-500 text-sm mb-6">
          {didWin ? 'Your charity receives the donation.' : 'Better luck next time.'}
        </p>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-slate-900 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-2 uppercase tracking-wider">Your charity</p>
            <img
              src={yourCharity.logoUrl}
              alt={yourCharity.name}
              className="w-10 h-10 mx-auto mb-2 rounded-lg"
            />
            <p className="text-sm font-medium text-slate-200">{yourCharity.name}</p>
          </div>
          <div className="bg-slate-900 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-2 uppercase tracking-wider">Opponent's</p>
            <img
              src={opponentCharity.logoUrl}
              alt={opponentCharity.name}
              className="w-10 h-10 mx-auto mb-2 rounded-lg"
            />
            <p className="text-sm font-medium text-slate-200">{opponentCharity.name}</p>
          </div>
        </div>

        <div className="bg-slate-900 rounded-xl p-4 mb-6">
          <p className="text-2xl font-bold tabular-nums text-white mb-0.5">
            {formatCents(totalDonatedCents)}
          </p>
          <p className="text-sm text-slate-400">
            donated to {didWin ? yourCharity.name : opponentCharity.name}
          </p>
          <p className="text-xs text-slate-600 mt-1">
            {formatCents(betAmountCents)} + {formatCents(betAmountCents)} combined
          </p>
        </div>

        <button
          onClick={onPlayAgain}
          className="bg-cyan-400 text-slate-900 font-semibold px-8 py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors"
        >
          Play Again
        </button>
      </div>
    </div>
  );
}
