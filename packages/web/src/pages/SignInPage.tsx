import { useState } from 'react';
import { api } from '../api.js';
import { HalleyLogo } from '../components/HalleyLogo.js';

interface Props {
  repo: string;
  googleEnabled: boolean;
  devLoginEnabled: boolean;
  authError: string | null;
  deniedEmail: string | null;
  onLoggedIn: () => void;
}

export function SignInPage({
  repo,
  googleEnabled,
  devLoginEnabled,
  authError,
  deniedEmail,
  onLoggedIn,
}: Props) {
  const [devEmail, setDevEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const handleDevLogin = async () => {
    setBusy(true);
    try {
      await api.devLogin(devEmail || undefined);
      onLoggedIn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex min-h-dvh items-center justify-center bg-[#FAF9F7] px-4"
      style={{
        paddingTop: 'max(1rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-[#E7E5E4] bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2.5">
          <HalleyLogo className="h-9 w-9 shrink-0 rounded-xl shadow-xs" />
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-stone-500">Halley</p>
            <h1 className="text-lg font-semibold text-stone-900">{repo}</h1>
          </div>
        </div>

        <p className="mt-5 font-serif text-3xl leading-tight text-stone-900">
          Edit your website through{' '}
          <span className="italic text-amber-700">conversation &amp; click.</span>
        </p>
        <p className="mt-2.5 text-sm leading-relaxed text-stone-600">
          Sign in with your team Google account to make updates, preview changes live, and publish straight to your site.
        </p>

        {authError === 'not_allowed' && (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-950">
            <strong>{deniedEmail || 'This account'}</strong> doesn&apos;t have editor access yet. Please ask your site administrator to add your email.
          </div>
        )}

        {authError && authError !== 'not_allowed' && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Sign-in did not complete ({authError}). Please try again.
          </div>
        )}

        <div className="mt-7 space-y-3">
          {googleEnabled && (
            <a
              href="/api/auth/google"
              className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-stone-300 bg-white px-4 py-3 text-sm font-semibold text-stone-900 shadow-xs transition hover:bg-stone-50"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Continue with Google
            </a>
          )}

          {devLoginEnabled && (
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3.5">
              <p className="text-xs font-medium text-stone-500 mb-2">Local Dev Login</p>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={devEmail}
                  onChange={(e) => setDevEmail(e.target.value)}
                  placeholder="admin@example.com (optional)"
                  className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-amber-600"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleDevLogin}
                  className="rounded-lg bg-stone-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
                >
                  {busy ? 'Signing in…' : 'Dev Sign In'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
