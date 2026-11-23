import type { EditorSessionDto, SpendStatusDto } from '@halley/shared';
import { useEffect, useState } from 'react';
import { api, type AuthMeResponse } from './api.js';
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);

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

  if (!auth) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#FAF9F7] text-sm text-stone-500">
        Loading Halley…
      </div>
    );
  }

  if (!auth.authenticated || !auth.user) {
    return (
      <SignInPage
        repo={auth.repo}
        googleEnabled={Boolean(auth.googleEnabled)}
        devLoginEnabled={Boolean(auth.devLoginEnabled)}
        authError={authError}
        deniedEmail={deniedEmail}
        onLoggedIn={() => void refresh()}
      />
    );
  }

  if (showAdmin && auth.user.isAdmin) {
    return (
      <AdminPage
        onBack={() => {
          setShowAdmin(false);
          void refresh();
        }}
        onOpenSession={(id) => {
          setShowAdmin(false);
          setActiveSessionId(id);
        }}
      />
    );
  }

  if (activeSessionId) {
    return (
      <EditorPage
        sessionId={activeSessionId}
        user={auth.user}
        initialSpend={spend}
        onBack={() => {
          setActiveSessionId(null);
          void refresh();
        }}
        onOpenSession={(id) => setActiveSessionId(id)}
      />
    );
  }

  return (
    <DashboardPage
      user={auth.user}
      repo={auth.repo}
      sessions={sessions}
      spend={spend}
      onOpenSession={(id) => setActiveSessionId(id)}
      onOpenAdmin={() => setShowAdmin(true)}
      onRefresh={refresh}
      onLogout={async () => {
        await api.logout();
        setActiveSessionId(null);
        await refresh();
      }}
    />
  );
}
