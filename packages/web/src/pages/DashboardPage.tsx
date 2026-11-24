import type { EditorSessionDto, SpendStatusDto, UserDto } from '@halley/shared';
import {
  CheckCircle2,
  Copy,
  Loader2,
  LogOut,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.js';

interface Props {
  user: UserDto;
  repo: string;
  sessions: EditorSessionDto[];
  spend: SpendStatusDto;
  onOpenSession: (id: string) => void;
  onOpenAdmin: () => void;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}

function statusBadge(s: EditorSessionDto) {
  if (s.status === 'published' || s.publishState === 'published') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200/70">
        <CheckCircle2 className="h-3 w-3" /> Published
      </span>
    );
  }
  if (
    s.publishState === 'failed_checks' ||
    s.publishState === 'failed_conflict' ||
    s.publishState === 'failed_ci'
  ) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 border border-amber-200">
        Needs attention
      </span>
    );
  }
  if (
    s.publishState === 'verifying' ||
    s.publishState === 'rebasing' ||
    s.publishState === 'pushing_pr' ||
    s.publishState === 'waiting_ci' ||
    s.publishState === 'deploying_pages'
  ) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
        Publishing…
      </span>
    );
  }
  if (s.status === 'starting') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 border border-amber-200">
        <Loader2 className="h-3 w-3 animate-spin" /> Starting…
      </span>
    );
  }
  if (s.status === 'error') {
    return (
      <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700 border border-red-200">
        Start failed
      </span>
    );
  }
  if (s.status === 'sleeping') {
    return (
      <span className="inline-flex items-center rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-600">
        Sleeping
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-stone-900 px-2.5 py-0.5 text-xs font-medium text-white">
      Editing
    </span>
  );
}

export function DashboardPage({
  user,
  repo,
  sessions,
  spend,
  onOpenSession,
  onOpenAdmin,
  onRefresh,
  onLogout,
}: Props) {
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const mySessions = sessions.filter((s) => s.isOwner);
  const teamSessions = sessions.filter((s) => !s.isOwner);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      const { session } = await api.createSession(title.trim());
      setTitle('');
      onOpenSession(session.id);
    } finally {
      setCreating(false);
    }
  };

  const handleDuplicate = async (id: string) => {
    const { session } = await api.duplicateSession(id);
    onOpenSession(session.id);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this draft edit? Unsaved changes in this draft will be discarded.')) return;
    await api.deleteSession(id);
    await onRefresh();
  };

  return (
    <div className="min-h-screen bg-[#FAF9F7]">
      <header className="border-b border-[#E7E5E4] bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 text-amber-700 border border-amber-200/70">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <span className="text-sm font-semibold text-stone-900">Halley</span>
            <span className="text-stone-300">/</span>
            <span className="text-sm text-stone-500">{repo}</span>
          </div>

          <div className="flex items-center gap-3">
            {user.isAdmin && (
              <button
                type="button"
                onClick={onOpenAdmin}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
              >
                <Settings className="h-3.5 w-3.5" />
                Admin
              </button>
            )}
            <div className="flex items-center gap-2 text-xs text-stone-600">
              {user.picture && (
                <img src={user.picture} alt={user.name} className="h-6 w-6 rounded-full" />
              )}
              <span>{user.name}</span>
            </div>
            <button
              type="button"
              onClick={onLogout}
              title="Sign out"
              className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {spend.capped && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            You&apos;ve reached today&apos;s AI editing budget (${(spend.dailyCapUsd + spend.extraGrantedUsd).toFixed(2)}). Inline text editing still works, or ask an admin to grant extra allowance.
          </div>
        )}

        <section className="rounded-2xl border border-[#E7E5E4] bg-white p-6 shadow-2xs">
          <h1 className="font-serif text-3xl text-stone-900">What would you like to update?</h1>
          <p className="mt-1 text-sm text-stone-500">
            Start a new draft to make changes safely without affecting the live website until you publish.
          </p>

          <form onSubmit={handleCreate} className="mt-5 flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Update Easter service times, Add Youth retreat photos…"
              className="flex-1 rounded-xl border border-stone-300 bg-[#FAF9F7] px-4 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 outline-none focus:border-amber-600 focus:bg-white"
            />
            <button
              type="submit"
              disabled={!title.trim() || creating}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
              {creating ? 'Starting…' : 'New edit'}
            </button>
          </form>
        </section>

        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
            Your Edits ({mySessions.length})
          </h2>
          {mySessions.length === 0 ? (
            <p className="mt-3 text-sm text-stone-500">No edits yet — create one above to get started.</p>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {mySessions.map((s) => (
                <div
                  key={s.id}
                  className="group flex flex-col justify-between rounded-xl border border-[#E7E5E4] bg-white p-4 transition hover:border-stone-300 hover:shadow-xs"
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => onOpenSession(s.id)}
                      className="text-left flex-1"
                    >
                      <h3 className="font-semibold text-stone-900 group-hover:text-amber-800">
                        {s.title}
                      </h3>
                      <p className="mt-1 text-xs text-stone-500">
                        {s.changedFilesCount > 0
                          ? `${s.changedFilesCount} page/file change${s.changedFilesCount === 1 ? '' : 's'}`
                          : 'No changes yet'}
                        {' · '}
                        {new Date(s.lastActiveAt).toLocaleDateString()}
                      </p>
                    </button>
                    {statusBadge(s)}
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3">
                    <button
                      type="button"
                      onClick={() => onOpenSession(s.id)}
                      className="text-xs font-semibold text-stone-700 hover:text-amber-700"
                    >
                      {s.status === 'published' ? 'View archive →' : 'Open editor →'}
                    </button>
                    {s.status !== 'published' && (
                      <button
                        type="button"
                        onClick={() => handleDelete(s.id)}
                        title="Discard draft"
                        className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {teamSessions.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Team Edits (Read-only)
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {teamSessions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-col justify-between rounded-xl border border-[#E7E5E4] bg-white/70 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-stone-900">{s.title}</h3>
                      <p className="mt-1 text-xs text-stone-500">
                        By {s.ownerName} · {new Date(s.lastActiveAt).toLocaleDateString()}
                      </p>
                    </div>
                    {statusBadge(s)}
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3">
                    <button
                      type="button"
                      onClick={() => onOpenSession(s.id)}
                      className="text-xs font-medium text-stone-600 hover:text-stone-900"
                    >
                      View read-only →
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDuplicate(s.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                    >
                      <Copy className="h-3 w-3" />
                      Duplicate to my edits
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
