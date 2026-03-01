import { Routes, Route } from 'react-router-dom';
import { useAppAuth } from './auth/useAppAuth';
import { Layout } from './components/Layout';
import { AuthGuard } from './components/AuthGuard';
import { MobileBlocker } from './components/MobileBlocker';
import { HomePage } from './pages/HomePage';
import { PracticePage } from './pages/PracticePage';
import { RulesPage } from './pages/RulesPage';
import { PolicyPage } from './pages/PolicyPage';
import { DonationsPage } from './pages/DonationsPage';
import { InvitePage } from './pages/InvitePage';
import { GamePage } from './pages/GamePage';
import { LoginPage } from './pages/LoginPage';
import { TaxExemptionPage } from './pages/TaxExemptionPage';
import { HistoryPage } from './pages/HistoryPage';
import { DevGamePage } from './pages/DevGamePage';
import { useMobile } from './hooks/useMobile';

export function App(): React.JSX.Element {
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
      <Route path="/policy" element={<PolicyPage />} />
      {import.meta.env.DEV && <Route path="/dev/game" element={<DevGamePage />} />}
      <Route path="/invite/:token" element={<InvitePage />} />

      {/* Protected routes */}
      <Route element={<AuthGuard />}>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/tax-exemption" element={<TaxExemptionPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/donations" element={<DonationsPage />} />
        </Route>
        <Route path="/game/:id" element={<GamePage />} />
      </Route>
    </Routes>
  );
}
