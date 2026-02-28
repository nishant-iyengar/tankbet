export function MobileBlocker(): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-900 px-8 text-center">
      <div className="mb-6 text-6xl">🎮</div>
      <h1 className="mb-3 text-2xl font-bold text-white">
        Desktop Only
      </h1>
      <p className="max-w-xs text-slate-400 leading-relaxed">
        TankBet requires a keyboard to play. Please open this site on a desktop
        or laptop computer.
      </p>
    </div>
  );
}
