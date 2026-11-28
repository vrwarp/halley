import type { EditorSessionDto, SpendStatusDto } from '@halley/shared';
import { useEffect, useRef, useState } from 'react';
import { api, type AuthMeResponse } from './api.js';
import { LoadErrorScreen } from './components/ErrorBoundary.js';
import { backoffDelayMs, errorMessage, reportIgnored } from './lib/retry.js';
import { AdminPage } from './pages/AdminPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { EditorPage } from './pages/EditorPage.js';
import { SignInPage } from './pages/SignInPage.js';

export function App() {
  const [auth, setAuth] = useState<AuthMeResponse | null>(null);
  const [sessions, setSessions] = useState<EditorSessionDto[]>([]);
  const [spend, setSpend] = useState<SpendStatusDto>({
    spentTodayUsd: 0,
    dailyCapUsd: 10,
    extraGrantedUsd: 0,
    capped: false,
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('session') || null;
    } catch (err) {
      reportIgnored(err, 'reading ?session= from the URL failed');
      return null;
    }
  });
  const [openPublishOnLoad, setOpenPublishOnLoad] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [focusOptimize, setFocusOptimize] = useState(false);

  const syncSessionUrl = (id: string | null) => {
    try {
      const next = new URL(window.location.href);
      if (id) {
        next.searchParams.set('session', id);
      } else {
        next.searchParams.delete('session');
      }
      window.history.replaceState(null, '', `${next.pathname}${next.search}${next.hash}`);
    } catch (err) {
      reportIgnored(err, 'history.replaceState for ?session= failed');
    }
  };

  const openSession = (id: string, opts?: { openPublish?: boolean }) => {
    setOpenPublishOnLoad(Boolean(opts?.openPublish));
    setActiveSessionId(id);
    syncSessionUrl(id);
    void api
      .listSessions()
      .then((list) => {
        setSessions(list.sessions);
        setSpend(list.spend);
      })
      .catch((err) => reportIgnored(err, 'background session list refresh failed; next refresh retries'));
  };

  const params = new URLSearchParams(window.location.search);
  const authError = params.get('authError');
  const deniedEmail = params.get('email');

  const [loadError, setLoadError] = useState<{ message: string; retryInMs: number | null } | null>(
    null,
  );
  const refreshGenRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Never rejects: failures surface as `loadError` (full-screen before the first successful
   * load, a banner afterwards) and schedule an automatic retry with exponential backoff.
   * A generation counter drops responses from superseded calls.
   */
  const refresh = async (opts?: { manual?: boolean }): Promise<void> => {
    const gen = ++refreshGenRef.current;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (opts?.manual) retryAttemptRef.current = 0;
    try {
      const me = await api.me();
      if (gen !== refreshGenRef.current) return;
      setAuth(me);
      if (me.authenticated) {
        if (me.spend) setSpend(me.spend);
        const list = await api.listSessions();
        if (gen !== refreshGenRef.current) return;
        setSessions(list.sessions);
        setSpend(list.spend);
      }
      retryAttemptRef.current = 0;
      setLoadError(null);
    } catch (err) {
      if (gen !== refreshGenRef.current) return;
      const delay = backoffDelayMs(retryAttemptRef.current++);
      console.warn(`[halley] refresh failed, retrying in ${delay}ms`, err);
      setLoadError({ message: errorMessage(err, 'Could not reach Halley'), retryInMs: delay });
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void refresh();
      }, delay);
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      refreshGenRef.current++;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const loadErrorBanner =
    loadError && auth ? (
      <div
        role="alert"
        className="fixed inset-x-0 top-2 z-[100] mx-auto flex w-fit max-w-[calc(100%-32px)] items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow"
      >
        <span className="min-w-0 break-words">{loadError.message}</span>
        <button
          type="button"
          onClick={() => void refresh({ manual: true })}
          className="shrink-0 rounded-md bg-red-700 px-2 py-0.5 font-semibold text-white hover:bg-red-800"
        >
          Retry
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setLoadError(null)}
          className="shrink-0 px-1 text-red-700 hover:text-red-950"
        >
          ×
        </button>
      </div>
    ) : null;

  if (!auth && loadError) {
    return (
      <LoadErrorScreen
        title="Couldn't load Halley"
        message={loadError.message}
        retryInMs={loadError.retryInMs}
        onRetry={() => void refresh({ manual: true })}
      />
    );
  }

  if (!auth) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#FAF9F7] text-sm text-stone-500">
        Loading Halley…
      </div>
    );
  }

  if (!auth.authenticated || !auth.user) {
    return (
      <>
      {loadErrorBanner}
      <SignInPage
        repo={auth.repo}
        googleEnabled={Boolean(auth.googleEnabled)}
        devLoginEnabled={Boolean(auth.devLoginEnabled)}
        authError={authError}
        deniedEmail={deniedEmail}
        onLoggedIn={() => void refresh()}
      />
      </>
    );
  }

  if (showAdmin && auth.user.isAdmin) {
    return (
      <>
      {loadErrorBanner}
      <AdminPage
        focusOptimize={focusOptimize}
        onBack={() => {
          setShowAdmin(false);
          setFocusOptimize(false);
          void refresh();
        }}
        onOpenSession={(id) => {
          setShowAdmin(false);
          setFocusOptimize(false);
          openSession(id);
        }}
      />
      </>
    );
  }

  if (activeSessionId) {
    return (
      <>
      {loadErrorBanner}
      <EditorPage
        key={activeSessionId}
        sessionId={activeSessionId}
        user={auth.user}
        initialSpend={spend}
        initialOpenPublish={openPublishOnLoad}
        onBack={() => {
          setActiveSessionId(null);
          syncSessionUrl(null);
          setOpenPublishOnLoad(false);
          void refresh();
        }}
        onOpenSession={(id, opts) => openSession(id, opts)}
      />
      </>
    );
  }

  return (
    <>
    {loadErrorBanner}
    <DashboardPage
      user={auth.user}
      repo={auth.repo}
      sessions={sessions}
      spend={spend}
      onOpenSession={(id, opts) => openSession(id, opts)}
      onOpenAdmin={() => {
        setFocusOptimize(false);
        setShowAdmin(true);
      }}
      onOpenOptimize={() => {
        setFocusOptimize(true);
        setShowAdmin(true);
      }}
      onRefresh={refresh}
      onLogout={async () => {
        try {
          await api.logout();
        } catch (err) {
          setLoadError({ message: `Sign out failed: ${errorMessage(err)}`, retryInMs: null });
          return;
        }
        setActiveSessionId(null);
        syncSessionUrl(null);
        await refresh();
      }}
    />
    </>
  );
}
