import { useState, useEffect, useContext } from 'react';
import { useSignIn, useSignUp } from '@clerk/clerk-react';
import { isClerkAPIResponseError } from '@clerk/clerk-react/errors';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppAuth } from '../auth/useAppAuth';
import { DevAuthContext, type DevUser } from '../auth/DevAuthContext';
import { apiFetch } from '../api/client';
import { ErrorAlert } from '../components/ErrorAlert';

const IS_DEV = import.meta.env.DEV;

type Step = 'phone' | 'otp';
type Mode = 'signIn' | 'signUp';

interface DevUserResponse {
  id: string;
  clerkId: string;
  username: string;
  phoneNumber: string;
}

export function LoginPage(): React.JSX.Element {
  const { isSignedIn } = useAppAuth();
  const { isLoaded: signInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();
  const devAuth = useContext(DevAuthContext);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Dev login state
  const [devUsers, setDevUsers] = useState<DevUserResponse[]>([]);
  const [devLoading, setDevLoading] = useState(false);
  const [devError, setDevError] = useState('');

  // Load dev users on mount
  useEffect(() => {
    if (!IS_DEV) return;
    apiFetch<{ users: DevUserResponse[] }>('/api/dev/users')
      .then((r) => setDevUsers(r.users))
      .catch(() => setDevError('Failed to load dev users'));
  }, []);

  // Navigate only after auth state has fully propagated
  useEffect(() => {
    if (isSignedIn) {
      const redirect = searchParams.get('redirect');
      navigate(redirect ?? '/');
    }
  }, [isSignedIn, navigate, searchParams]);

  const [step, setStep] = useState<Step>('phone');
  const [mode, setMode] = useState<Mode>('signIn');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isLoaded = signInLoaded && signUpLoaded;

  async function handleDevLogin(user: DevUserResponse): Promise<void> {
    if (!devAuth) return;
    setDevLoading(true);
    setDevError('');
    try {
      await apiFetch<{ user: DevUser }>('/api/dev/login', {
        method: 'POST',
        body: { clerkId: user.clerkId },
      });
      devAuth.setDevUser({
        id: user.id,
        clerkId: user.clerkId,
        username: user.username,
        phoneNumber: user.phoneNumber,
      });
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Dev login failed');
    } finally {
      setDevLoading(false);
    }
  }

  async function handleSendCode(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!isLoaded) return;
    setError('');
    setLoading(true);
    try {
      // Try sign-in first
      await signIn.create({ strategy: 'phone_code', identifier: phoneNumber });
      setMode('signIn');
      setStep('otp');
    } catch (err: unknown) {
      if (isClerkAPIResponseError(err) && err.errors.some((e) => e.code === 'form_identifier_not_found')) {
        // New user — create account and send OTP
        try {
          await signUp.create({ phoneNumber });
          await signUp.preparePhoneNumberVerification({ strategy: 'phone_code' });
          setMode('signUp');
          setStep('otp');
        } catch (signUpErr: unknown) {
          if (isClerkAPIResponseError(signUpErr) && signUpErr.errors.length > 0) {
            setError(signUpErr.errors[0].longMessage ?? signUpErr.errors[0].message);
          } else if (signUpErr instanceof Error) {
            setError(signUpErr.message);
          } else {
            setError('Failed to send code. Please try again.');
          }
        }
      } else if (isClerkAPIResponseError(err) && err.errors.length > 0) {
        setError(err.errors[0].longMessage ?? err.errors[0].message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to send code. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!isLoaded) return;
    setError('');
    setLoading(true);
    try {
      if (mode === 'signIn') {
        const result = await signIn.attemptFirstFactor({ strategy: 'phone_code', code });
        if (result.status === 'complete' && result.createdSessionId !== null) {
          await setSignInActive({ session: result.createdSessionId });
        } else {
          setError('Sign-in could not be completed. Please try again.');
        }
      } else {
        const result = await signUp.attemptPhoneNumberVerification({ code });
        if (result.status === 'complete' && result.createdSessionId !== null) {
          await setSignUpActive({ session: result.createdSessionId });
        } else {
          setError('Verification could not be completed. Please try again.');
        }
      }
    } catch (err: unknown) {
      if (isClerkAPIResponseError(err) && err.errors.length > 0) {
        setError(err.errors[0].longMessage ?? err.errors[0].message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Invalid code. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  function handleBack(): void {
    setStep('phone');
    setCode('');
    setError('');
  }

  return (
    <div className="min-h-screen flex">
      {/* Left panel — hero image */}
      <div className="hidden lg:flex lg:w-1/2 xl:w-[55%] relative overflow-hidden">
        <img
          src="https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=1400&q=80&auto=format&fit=crop"
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#0a0e1a]/90 via-[#0a0e1a]/60 to-[#0a0e1a]/80" />

        {/* Branding content */}
        <div className="relative z-10 flex flex-col justify-center p-12 w-full h-full">
          <h1 className="text-3xl font-bold text-cyan-400 tracking-tight mb-6">TankBet</h1>
          <h2 className="text-4xl xl:text-5xl font-bold text-white leading-tight">
            Battle your friends.
            <br />
            <span className="text-cyan-400">Keep score.</span>
          </h2>
        </div>
      </div>

      {/* Right panel — login form */}
      <div className="w-full lg:w-1/2 xl:w-[45%] flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          {/* Mobile-only logo */}
          <div className="lg:hidden mb-10 text-center">
            <h1 className="text-3xl font-bold text-cyan-400 tracking-tight">TankBet</h1>
          </div>

          {/* Dev Login Section */}
          {IS_DEV && devUsers.length > 0 && (
            <div className="mb-6">
              <p className="text-xs font-medium text-amber-400/80 uppercase tracking-wider mb-3">Dev Login</p>
              <div className="space-y-2">
                {devUsers.map((user) => (
                  <button
                    key={user.clerkId}
                    onClick={() => void handleDevLogin(user)}
                    disabled={devLoading}
                    className="w-full flex items-center justify-between bg-slate-800 border border-amber-400/30 text-slate-200 rounded-lg px-4 py-3 text-sm hover:border-amber-400/60 hover:bg-slate-700 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <span className="font-medium">{user.username}</span>
                    <span className="text-slate-500 text-xs">{user.phoneNumber}</span>
                  </button>
                ))}
              </div>
              {devError && <ErrorAlert message={devError} className="mt-2" />}
              <div className="border-b border-slate-700/50 mt-6 mb-2" />
            </div>
          )}

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white mb-2">
              {step === 'phone' ? 'Sign in' : 'Verify your phone'}
            </h2>
            <p className="text-sm text-slate-400">
              {step === 'phone'
                ? 'Enter your phone number to receive a one-time code.'
                : `We sent a 6-digit code to ${phoneNumber}.`}
            </p>
          </div>

          {step === 'phone' && (
            <form onSubmit={(e) => void handleSendCode(e)}>
              <label className="block text-sm font-medium text-slate-400 mb-1.5">
                Phone number
              </label>
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+1 (555) 000-0000"
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 placeholder-slate-500 rounded-lg px-4 py-3 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-cyan-400/40 focus:border-cyan-400/50 transition-colors"
                required
                autoComplete="tel"
                autoFocus
              />
              {error && <ErrorAlert message={error} className="mb-3" />}
              <button
                type="submit"
                disabled={loading || !phoneNumber.trim()}
                className="w-full bg-cyan-400 text-slate-900 font-semibold py-3 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                {loading ? 'Sending…' : 'Continue'}
              </button>
            </form>
          )}

          {step === 'otp' && (
            <form onSubmit={(e) => void handleVerifyCode(e)}>
              <label className="block text-sm font-medium text-slate-400 mb-1.5">
                One-time code
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 placeholder-slate-500 rounded-lg px-4 py-3 text-center text-xl font-mono tracking-widest mb-4 focus:outline-none focus:ring-2 focus:ring-cyan-400/40 focus:border-cyan-400/50 transition-colors tabular-nums"
                required
                autoComplete="one-time-code"
                autoFocus
              />
              {error && <ErrorAlert message={error} className="mb-3" />}
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full bg-cyan-400 text-slate-900 font-semibold py-3 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none mb-3"
              >
                {loading ? 'Verifying…' : 'Verify Code'}
              </button>
              <button
                type="button"
                onClick={handleBack}
                disabled={loading}
                className="w-full text-sm text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
              >
                Use a different number
              </button>
            </form>
          )}

        </div>
      </div>
    </div>
  );
}
