export function TaxExemptionPage(): React.JSX.Element {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-6">Tax Exemption</h1>

      <div className="space-y-6">
        <section>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">501(c)(3) Charitable Giving</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            All charities on Tank Wars are registered 501(c)(3) nonprofit organizations. Donations
            made through Tank Wars may be tax-deductible to the extent permitted by law.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Annual Tax Reminder</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Each year in October, November, and December, we'll send you a text message summarizing
            your year-to-date donations on Tank Wars. You can use this as a reference when preparing
            your taxes — though we recommend consulting a tax professional.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">What Counts as a Donation</h2>
          <ul className="space-y-2">
            {[
              'The amount contributed when you win a game (your net bet amount × 2, going to your charity)',
              'The amount contributed when you lose a game (your bet amount, going to your opponent\'s charity)',
              'Neither player personally profits — all funds go directly to charity',
            ].map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-slate-300">
                <span className="text-cyan-400 mt-0.5">–</span>
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-2">Record Keeping</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Your full donation history is available on the Donations page. For official tax receipts,
            the 501(c)(3) organization itself is the issuing authority — Tank Wars records serve as a
            personal reference.
          </p>
        </section>

        <p className="text-xs text-slate-600 pt-2">
          Tank Wars is not a tax advisor. Consult a qualified tax professional for advice specific to your situation.
        </p>
      </div>
    </div>
  );
}
