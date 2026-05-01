import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { ErrorAlert } from '../components/ErrorAlert';

export function OnboardingPage(): React.JSX.Element {
  const [tosChecked, setTosChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { post } = useApi();

  async function handleConsent(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      await post('/api/users/onboard', {});
      await post('/api/users/accept-tos', {
        version: '1.0',
        userAgent: navigator.userAgent,
      });
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept ToS');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-cyan-400 mb-1">Welcome to Tank Battle</h1>
          <p className="text-sm text-slate-500">Step 1 of 1</p>
        </div>

        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6">
          {/* Progress bar */}
          <div className="flex gap-2 mb-6">
            <div className="h-1 flex-1 rounded-full bg-cyan-400" />
          </div>

          <div>
            <h2 className="text-base font-semibold text-white mb-3">Terms of Service</h2>
            <div className="bg-slate-800 rounded-lg p-4 mb-4 max-h-44 overflow-y-auto text-sm text-slate-400 space-y-2">
              <p>
                By using Tank Battle, you agree to participate in charitable gaming. All game outcomes
                result in donations to registered 501(c)(3) charities. No player personally profits
                from game outcomes.
              </p>
              <p>
                You certify that you are at least 18 years of age and that online charitable gaming
                is permitted in your jurisdiction.
              </p>
              <p>
                Tank Battle reserves the right to modify these terms with notice.
              </p>
            </div>
            <label className="flex items-center gap-3 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={tosChecked}
                onChange={(e) => setTosChecked(e.target.checked)}
                className="w-5 h-5 rounded accent-cyan-400 cursor-pointer"
              />
              <span className="text-sm text-slate-300">I have read and agree to the Terms of Service</span>
            </label>
            {error && <ErrorAlert message={error} className="mb-3" />}
            <button
              onClick={() => void handleConsent()}
              disabled={loading || !tosChecked}
              className="w-full bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              {loading ? 'Processing…' : 'Get Started'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
