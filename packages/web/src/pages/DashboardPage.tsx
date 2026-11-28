import type { EditorSessionDto, LiveHistoryEntryDto, SpendStatusDto, UserDto } from '@halley/shared';
import {
  CheckCircle2,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  LogOut,
  Plus,
  RotateCcw,
  Settings,
  Trash2,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BranchOffModal } from '../components/BranchOffModal.js';
import { HalleyLogo } from '../components/HalleyLogo.js';
import { InstallAppButton } from '../components/InstallAppButton.js';
import { reportIgnored } from '../lib/retry.js';

interface Props {
  user: UserDto;
  repo: string;
  sessions: EditorSessionDto[];
  spend: SpendStatusDto;
  onOpenSession: (id: string, opts?: { openPublish?: boolean }) => void;
  onOpenAdmin: () => void;
  onOpenOptimize?: () => void;
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
  if (s.status === 'merged') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 border border-amber-200">
        {s.publishState === 'failed_deploy' ? 'Merged (deploy check needed)' : 'Merged (deploy pending)'}
      </span>
    );
  }
  if (
    s.publishState === 'failed_checks' ||
    s.publishState === 'failed_conflict' ||
    s.publishState === 'failed_ci' ||
    s.publishState === 'failed_deploy'
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
  onOpenOptimize,
  onRefresh,
  onLogout,
}: Props) {
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'drafts' | 'history'>('drafts');
  const [history, setHistory] = useState<LiveHistoryEntryDto[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [undoTarget, setUndoTarget] = useState<LiveHistoryEntryDto | null>(null);
  const [undoReason, setUndoReason] = useState('');
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EditorSessionDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [branchTarget, setBranchTarget] = useState<EditorSessionDto | null>(null);
  const [branchingOff, setBranchingOff] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  const isFinished = (s: EditorSessionDto) => s.status === 'published' || s.status === 'merged';
  const myDrafts = sessions.filter((s) => s.isOwner && !isFinished(s));
  const teamDrafts = sessions.filter((s) => !s.isOwner && !isFinished(s));

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await api.listHistory();
      setHistory(res.entries);
    } catch (err) {
      reportIgnored(err, 'publish history unavailable');
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, [sessions.length]);

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

  const handleBranchOff = (s: EditorSessionDto) => {
    setBranchError(null);
    setBranchTarget(s);
  };

  const handleConfirmBranchOff = async () => {
    if (!branchTarget || branchingOff) return;
    setBranchingOff(true);
    setBranchError(null);
    try {
      const { session } = await api.duplicateSession(branchTarget.id);
      setBranchTarget(null);
      onOpenSession(session.id);
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : 'Could not branch off draft');
    } finally {
      setBranchingOff(false);
    }
  };

  const handleDelete = (s: EditorSessionDto) => {
    setDeleteTarget(s);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.deleteSession(deleteTarget.id);
      setDeleteTarget(null);
      await onRefresh();
    } finally {
      setDeleting(false);
    }
  };

  const handleConfirmUndo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!undoTarget || !undoReason.trim() || undoBusy) return;
    setUndoBusy(true);
    setUndoError(null);
    try {
      const { session } = await api.revertPublication({
        sessionId: undoTarget.sessionId ?? undefined,
        sha: undoTarget.sha,
        reason: undoReason.trim(),
        title: undoTarget.title,
      });
      setUndoTarget(null);
      setUndoReason('');
      // Q17: Open the revert session in the Editor with Live vs Draft Publish modal already open
      onOpenSession(session.id, { openPublish: true });
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : 'Could not start undo');
    } finally {
      setUndoBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[#FAF9F7] text-[#1C1917]">
      <header
        className="sticky top-0 z-20 border-b border-[#E7E5E4] bg-white/90 backdrop-blur"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <HalleyLogo className="h-8 w-8 shrink-0 rounded-lg" />
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-tight text-stone-900">Halley</h1>
              <p className="truncate text-xs text-stone-500">{repo}</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <span className="hidden text-xs text-stone-500 md:inline">
              Daily AI budget: ${spend.spentTodayUsd.toFixed(2)} / $
              {(spend.dailyCapUsd + spend.extraGrantedUsd).toFixed(2)}
            </span>
            <InstallAppButton />
            {user.isAdmin && (
              <>
                {onOpenOptimize && (
                  <button
                    type="button"
                    onClick={onOpenOptimize}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100/70 sm:px-3"
                  >
                    <Zap className="h-3.5 w-3.5 text-amber-600" />
                    <span className="hidden sm:inline">Optimize Astro</span>
                    <span className="sm:hidden">Optimize</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onOpenAdmin}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 sm:px-3"
                >
                  <Settings className="h-3.5 w-3.5" />
                  <span>Admin</span>
                </button>
              </>
            )}
            <div className="flex items-center gap-1.5 border-l border-stone-200 pl-2 sm:gap-2 sm:pl-3">
              <span className="hidden max-w-[120px] truncate text-xs font-medium text-stone-700 sm:inline">
                {user.name}
              </span>
              <button
                type="button"
                onClick={onLogout}
                title="Sign out"
                aria-label="Sign out"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-900"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <section className="rounded-2xl border border-[#E7E5E4] bg-white p-4 shadow-xs sm:p-6">
          <h2 className="text-lg font-semibold text-stone-900">Start a new website edit</h2>
          <p className="mt-1 text-sm text-stone-500">
            Every edit gets its own private live preview. Publish whenever you&apos;re ready.
          </p>
          <form onSubmit={handleCreate} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder='e.g. "Update Easter service times" or "Add Fall Retreat page"'
              className="flex-1 rounded-xl border border-stone-300 bg-[#FAF9F7] px-4 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:bg-white focus:outline-none"
            />
            <button
              type="submit"
              disabled={!title.trim() || creating}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
              {creating ? 'Starting…' : 'New edit'}
            </button>
          </form>
        </section>

        {/* Q20: Split Dashboard into Active Drafts vs Published History */}
        <div className="mt-6 flex items-center gap-1 border-b border-stone-200 sm:mt-8 sm:gap-2">
          <button
            type="button"
            onClick={() => setTab('drafts')}
            className={`border-b-2 px-3 py-2.5 text-xs font-semibold transition sm:px-4 sm:text-sm ${
              tab === 'drafts'
                ? 'border-stone-900 text-stone-900'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            Active Drafts ({myDrafts.length + teamDrafts.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('history');
              void loadHistory();
            }}
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold transition sm:px-4 sm:text-sm ${
              tab === 'history'
                ? 'border-stone-900 text-stone-900'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            <History className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            Published History ({history.length})
          </button>
        </div>

        {tab === 'drafts' ? (
          <>
            <section className="mt-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                Your Active Drafts ({myDrafts.length})
              </h2>
              {myDrafts.length === 0 ? (
                <p className="mt-3 text-sm text-stone-500">
                  No active drafts — start a new edit above or continue from Published History.
                </p>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {myDrafts.map((s) => (
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
                          <div className="flex items-center gap-1.5">
                            <h3 className="font-semibold text-stone-900 group-hover:text-amber-800">
                              {s.title}
                            </h3>
                            {s.kind === 'continuation' && (
                              <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-600">
                                Continued
                              </span>
                            )}
                            {s.kind === 'revert' && (
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                                Undo draft
                              </span>
                            )}
                          </div>
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
                          Open editor →
                        </button>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleBranchOff(s)}
                            title="Branch off a copy of this draft"
                            className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-2 py-1 text-[11px] font-medium text-stone-600 hover:bg-stone-50"
                          >
                            <GitBranch className="h-3 w-3" />
                            Branch off
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(s)}
                            title="Discard draft"
                            aria-label="Discard draft"
                            className="flex h-8 w-8 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-red-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {teamDrafts.length > 0 && (
              <section className="mt-8">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                  Team Drafts (Read-only)
                </h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {teamDrafts.map((s) => (
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
                          onClick={() => void handleDuplicate(s.id)}
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
          </>
        ) : (
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Live Site Timeline (Halley publications &amp; GitHub commits)
            </h2>
            {loadingHistory && history.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">Loading published history…</p>
            ) : history.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">No published edits yet.</p>
            ) : (
              <div className="mt-3 divide-y divide-stone-200 rounded-xl border border-[#E7E5E4] bg-white">
                {history.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <GitCommitHorizontal className="h-4 w-4 shrink-0 text-stone-400" />
                        <span className="font-semibold text-sm text-stone-900">{entry.title}</span>
                        {entry.source === 'github' && (
                          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
                            GitHub commit
                          </span>
                        )}
                        {entry.sessionKind === 'continuation' && (
                          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
                            Continued
                          </span>
                        )}
                        {entry.sessionKind === 'revert' && (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 border border-amber-200">
                            Undo
                          </span>
                        )}
                        {entry.revertedBy && (
                          <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700 border border-red-200">
                            Undone by {entry.revertedBy.authorName}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-stone-500">
                        {entry.authorName} · {new Date(entry.timestamp).toLocaleString()} ·{' '}
                        <span className="font-mono">{entry.shortSha}</span>
                        {entry.revertReason ? ` · Reason: ${entry.revertReason}` : ''}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {entry.sessionId && (
                        <>
                          <button
                            type="button"
                            onClick={() => onOpenSession(entry.sessionId!)}
                            className="rounded-lg border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                          >
                            View archive
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDuplicate(entry.sessionId!)}
                            className="inline-flex items-center gap-1 rounded-lg bg-stone-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-stone-800"
                          >
                            <Copy className="h-3 w-3" />
                            Continue editing
                          </button>
                        </>
                      )}
                      {entry.canUndo ? (
                        <button
                          type="button"
                          onClick={() => {
                            setUndoTarget(entry);
                            setUndoReason('');
                            setUndoError(null);
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-700 hover:border-red-300 hover:text-red-700"
                        >
                          <RotateCcw className="h-3 w-3" />
                          {entry.sessionKind === 'revert' ? 'Put it back' : 'Undo'}
                        </button>
                      ) : (
                        entry.undoDisabledReason && (
                          <span className="text-[11px] text-stone-400">
                            {entry.undoDisabledReason}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {/* Undo publication reason modal (Q1, Q5, Q17) */}
      {undoTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/35 p-4 backdrop-blur-[2px]">
          <form
            onSubmit={handleConfirmUndo}
            className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-xl space-y-4"
          >
            <div>
              <h3 className="text-base font-semibold text-stone-900">
                Undo &ldquo;{undoTarget.title}&rdquo;?
              </h3>
              <p className="mt-1 text-xs text-stone-500">
                This prepares an undo on top of the latest live site and opens the Live vs Draft
                review so you can inspect (or undo only specific files) before publishing.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">
                Reason for undoing (required)
              </label>
              <input
                type="text"
                required
                value={undoReason}
                onChange={(e) => setUndoReason(e.target.value)}
                placeholder='e.g. "Wrong service time listed on Easter banner"'
                className="w-full rounded-xl border border-stone-300 px-3.5 py-2 text-sm focus:border-stone-900 focus:outline-none"
              />
            </div>
            {undoError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{undoError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setUndoTarget(null)}
                className="rounded-lg px-3.5 py-2 text-xs font-medium text-stone-600 hover:bg-stone-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!undoReason.trim() || undoBusy}
                className="min-h-[40px] rounded-lg bg-stone-900 px-4 py-2 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
              >
                {undoBusy ? 'Preparing undo…' : 'Review & undo'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/35 p-4 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 shadow-xl space-y-4 sm:p-6"
          >
            <div>
              <h3 className="text-base font-semibold text-stone-900">
                Discard &ldquo;{deleteTarget.title}&rdquo;?
              </h3>
              <p className="mt-1 text-xs text-stone-500">
                This permanently removes this unpublished draft and its workspace. Your live site is not affected.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="min-h-[40px] rounded-lg px-3.5 py-2 text-xs font-medium text-stone-600 hover:bg-stone-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
                className="min-h-[40px] rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? 'Discarding…' : 'Discard draft'}
              </button>
            </div>
          </div>
        </div>
      )}

      {branchTarget && (
        <BranchOffModal
          draftTitle={branchTarget.title}
          busy={branchingOff}
          error={branchError}
          onCancel={() => {
            if (!branchingOff) {
              setBranchTarget(null);
              setBranchError(null);
            }
          }}
          onConfirm={() => void handleConfirmBranchOff()}
        />
      )}
    </div>
  );
}
