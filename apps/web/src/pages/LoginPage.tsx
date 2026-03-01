import { useState, useEffect } from 'react';
import { useSignIn, useSignUp, useAuth } from '@clerk/clerk-react';
import { isClerkAPIResponseError } from '@clerk/clerk-react/errors';
import { useNavigate, useSearchParams } from 'react-router-dom';


type Step = 'phone' | 'otp';
type Mode = 'signIn' | 'signUp';

export function LoginPage(): React.JSX.Element {
  const { isSignedIn } = useAuth();
  const { isLoaded: signInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Navigate only after Clerk's isSignedIn state has fully propagated
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
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <div>
            <h1 className="text-3xl font-bold text-cyan-400 tracking-tight">TankBet</h1>
          </div>

          <div className="max-w-md">
            <h2 className="text-4xl xl:text-5xl font-bold text-white leading-tight mb-4">
              Battle your friends.
              <br />
              <span className="text-cyan-400">Bet on it.</span>
            </h2>
            <p className="text-slate-400 text-lg leading-relaxed">
              Challenge a friend to a 1v1 tank battle. Loser's bet goes straight to charity. No excuses.
            </p>
          </div>

          <p className="text-slate-600 text-xs">
            All bets are donated to verified charities.
          </p>
        </div>
      </div>

      {/* Right panel — login form */}
      <div className="w-full lg:w-1/2 xl:w-[45%] flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          {/* Mobile-only logo */}
          <div className="lg:hidden mb-10 text-center">
            <h1 className="text-3xl font-bold text-cyan-400 tracking-tight">TankBet</h1>
          </div>

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
              {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
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
              {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
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

          <p className="text-xs text-slate-600 mt-8 text-center leading-relaxed">
            By continuing, you agree to our Terms of Service and acknowledge our Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  );
}
