export function PolicyPage(): React.JSX.Element {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-8">Terms of Service</h1>

      <div className="space-y-6">
        {[
          {
            title: '1. Overview',
            body: 'Tank Wars is a charitable gaming platform. All game outcomes result in donations to registered 501(c)(3) charities. No player personally profits from game outcomes.',
          },
          {
            title: '2. Eligibility',
            body: 'You must be at least 18 years of age to use Tank Wars. By creating an account, you certify that you meet this requirement and that charitable gaming is legal in your jurisdiction.',
          },
          {
            title: '3. Game Funds',
            body: 'Game bets are committed when an invite is accepted and disbursed automatically at game end. There are no manual deposits or withdrawals.',
          },
          {
            title: '4. Charitable Donations',
            body: "Game bets are committed to charity. The full bet amount is donated to the winning player's chosen charity.",
          },
          {
            title: '5. Game Rules',
            body: 'Each player has 5 lives per game. If a player disconnects during a game, they have 30 seconds to reconnect before the game is forfeited. Forfeited games are treated the same as lost games for donation purposes.',
          },
          {
            title: '6. Modifications',
            body: 'Tank Wars reserves the right to modify these terms at any time with reasonable notice. Continued use of the platform constitutes acceptance of modified terms.',
          },
        ].map((section) => (
          <section key={section.title}>
            <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">
              {section.title}
            </h2>
            <p className="text-slate-300 text-sm leading-relaxed">{section.body}</p>
          </section>
        ))}

        <p className="text-xs text-slate-600 pt-4">Last updated: February 2026</p>
      </div>
    </div>
  );
}
