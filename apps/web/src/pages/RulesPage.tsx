export function RulesPage(): React.JSX.Element {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-6">How to Play</h1>

      <div className="space-y-6">
        <section>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Objective</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Eliminate your opponent by depleting all 5 of their lives. Each hit removes one life.
            The winner's chosen charity receives the combined bet from both players.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Controls</h2>
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
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Bullets</h2>
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
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Betting</h2>
          <ul className="space-y-2">
            {[
              'Choose from $1, $2, or $5 bets',
              'Both players wager the same amount',
              'All proceeds go to the winner\'s charity',
              'Neither player personally profits',
            ].map((rule) => (
              <li key={rule} className="flex items-start gap-2 text-sm text-slate-300">
                <span className="text-cyan-400 mt-0.5">–</span>
                {rule}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Disconnection</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            If you disconnect during a game, you have 30 seconds to reconnect. After that, the game
            is forfeited and your opponent wins.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Charity Model</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Both players select a charity before the game begins — hidden from each other.
            When the game ends, both charities are revealed. The total bet amount (minus a
            5% processing fee) goes to the winner's chosen charity.
          </p>
        </section>

        <p className="text-xs text-slate-600 pt-2">
          By playing, you agree to our{' '}
          <a href="/policy" className="text-slate-500 hover:text-slate-300 underline transition-colors">
            Terms of Service
          </a>.
        </p>
      </div>
    </div>
  );
}
