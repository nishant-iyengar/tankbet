import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAppClerk } from '../auth/useAppAuth';
import { useEffect, useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';

interface UserData {
  username: string;
}

export function Layout(): React.JSX.Element {
  const location = useLocation();
  const { signOut } = useAppClerk();
  const { get, post } = useApi();
  const [userData, setUserData] = useState<UserData | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);

  const refreshUser = useCallback(() => {
    get<UserData>('/api/users/me').then(setUserData).catch(() => {});
  }, [get]);

  useEffect(() => {
    post('/api/users/onboard', {})
      .catch(() => {/* no-op if already exists */})
      .finally(() => { refreshUser(); });
  }, [post, refreshUser]);

  const navItems = [
    { label: 'Home',     path: '/' },
    { label: 'Practice', path: '/practice' },
    { label: 'History', path: '/history' },
  ];

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-52 bg-slate-900 border-r border-slate-700/50 flex flex-col fixed h-full">
        <div className="px-5 py-5 border-b border-slate-700/50">
          <Link to="/" className="text-xl font-bold tracking-tight text-cyan-400">
            TankBet
          </Link>
        </div>

        <nav className="flex-1 p-3 space-y-0.5">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname === item.path
                  ? 'text-cyan-400 bg-cyan-400/10'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 ml-52">
        {/* Top bar */}
        <header className="h-14 border-b border-slate-700/50 flex items-center justify-end gap-3 px-6 bg-slate-900/60 backdrop-blur-sm sticky top-0 z-40">
          <div className="relative">
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              className="text-sm font-medium text-slate-300 hover:text-white transition-colors flex items-center gap-1.5"
            >
              {userData !== null && <span>{userData.username}</span>}
              <svg className="w-3 h-3 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showDropdown && (
              <div className="absolute right-0 mt-2 w-44 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl py-1 z-50">
                <button
                  onClick={() => void signOut()}
                  className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
                >
                  Log out
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
