import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useAppAuth } from './auth/useAppAuth';
import { Layout } from './components/Layout';
import { AuthGuard } from './components/AuthGuard';
import { MobileBlocker } from './components/MobileBlocker';
import { HomePage } from './pages/HomePage';
import { PracticePage } from './pages/PracticePage';
import { InvitePage } from './pages/InvitePage';
import { GamePage } from './pages/GamePage';
import { LoginPage } from './pages/LoginPage';
import { HistoryPage } from './pages/HistoryPage';
import { DevGamePage } from './pages/DevGamePage';
import { useMobile } from './hooks/useMobile';
import { GRACE_PERIOD_SECONDS } from '@tankbet/game-engine/constants';

const RECONNECT_KEY_PREFIX = 'tankbet:reconnect:';
const RECONNECT_TIMESTAMP_PREFIX = 'tankbet:reconnect-ts:';

/** Remove stale reconnection tokens from localStorage on app startup. */
function sweepStaleReconnectTokens(): void {
  const maxAge = GRACE_PERIOD_SECONDS * 1000;
  const now = Date.now();
  const keysToRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(RECONNECT_TIMESTAMP_PREFIX)) continue;

    const ts = Number(localStorage.getItem(key));
    if (Number.isNaN(ts) || now - ts > maxAge) {
      const gameId = key.slice(RECONNECT_TIMESTAMP_PREFIX.length);
      keysToRemove.push(key);
      keysToRemove.push(RECONNECT_KEY_PREFIX + gameId);
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}

export function App(): React.JSX.Element {
  useEffect(() => {
    sweepStaleReconnectTokens();
  }, []);
  const { isLoaded } = useAppAuth();
  const isMobile = useMobile();

  if (isMobile) {
    return <MobileBlocker />;
  }

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0e1a]">
        <div className="w-9 h-9 rounded-full border-2 border-slate-700 border-t-cyan-400 animate-spin" />
      </div>
    );
  }

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      {import.meta.env.DEV && <Route path="/dev/game" element={<DevGamePage />} />}
      <Route path="/invite/:token" element={<InvitePage />} />

      {/* Protected routes */}
      <Route element={<AuthGuard />}>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/history" element={<HistoryPage />} />
        </Route>
        <Route path="/game/:id" element={<GamePage />} />
      </Route>
    </Routes>
  );
}
