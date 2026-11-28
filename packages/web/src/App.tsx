import type { EditorSessionDto, SpendStatusDto } from '@halley/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { api, type AuthMeResponse } from './api.js';
import { PwaUpdateToast } from './components/PwaUpdateToast.js';
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
    } catch {
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
    } catch {
      // ignore
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
      .catch(() => {});
  };

  const params = new URLSearchParams(window.location.search);
  const authError = params.get('authError');
  const deniedEmail = params.get('email');

  const refresh = async () => {
    const me = await api.me();
    setAuth(me);
    if (me.authenticated) {
      if (me.spend) setSpend(me.spend);
      const list = await api.listSessions();
      setSessions(list.sessions);
      setSpend(list.spend);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  let view: ReactNode;

  if (!auth) {
    view = (
      <div className="flex h-dvh items-center justify-center bg-[#FAF9F7] text-sm text-stone-500">
        Loading Halley…
      </div>
    );
  } else if (!auth.authenticated || !auth.user) {
    view = (
      <SignInPage
        repo={auth.repo}
        googleEnabled={Boolean(auth.googleEnabled)}
        devLoginEnabled={Boolean(auth.devLoginEnabled)}
        authError={authError}
        deniedEmail={deniedEmail}
        onLoggedIn={() => void refresh()}
      />
    );
  } else if (showAdmin && auth.user.isAdmin) {
    view = (
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
    );
  } else if (activeSessionId) {
    view = (
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
    );
  } else {
    view = (
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
          await api.logout();
          setActiveSessionId(null);
          syncSessionUrl(null);
          await refresh();
        }}
      />
    );
  }

  return (
    <>
      {view}
      <PwaUpdateToast />
    </>
  );
}
