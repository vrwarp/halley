import type {
  ChangeCardDto,
  EditorSessionDto,
  MergeReviewStateDto,
  PublishProgressPayload,
  VerificationCheckResult,
  VisualDiffPageDto,
} from '@halley/shared';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MessageSquare,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConflictCards } from './ConflictCards.js';
import { VisualReview } from './VisualReview.js';

interface Props {
  session: EditorSessionDto;
  persona?: 'non-technical' | 'developer';
  publishProgress: PublishProgressPayload | null;
  onClose: () => void;
  onAskHalleyToFix: (summary: string, logs?: string) => Promise<void>;
  onStartNewEdit: () => void;
  onChangedFilesUpdated: () => Promise<void>;
}

const STEPS: Array<{ key: string; label: string; detail: string }> = [
  {
    key: 'verifying',
    label: 'Checking links, SEO & page build',
    detail: 'Building every page and checking links, images, and SEO.',
  },
  {
    key: 'rebasing',
    label: 'Syncing with current live website',
    detail: 'Making sure your draft stays in sync with any recent live updates.',
  },
  {
    key: 'waiting_ci',
    label: 'Verifying on GitHub',
    detail: 'Running final automated checks before updating the live site.',
  },
  {
    key: 'deploying_pages',
    label: 'Live on GitHub ✓ — deploying to website (~1 min)',
    detail: 'Publishing the built pages to the live website.',
  },
  {
    key: 'published',
    label: 'Published to Live Site ✓',
    detail: 'Everything is live for visitors now.',
  },
];

export function PublishModal({
  session,
  persona = 'non-technical',
  publishProgress,
  onClose,
  onAskHalleyToFix,
  onStartNewEdit,
  onChangedFilesUpdated,
}: Props) {
  const isPhone = typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;
  const [title, setTitle] = useState(session.title);
  const [titleDirty, setTitleDirty] = useState(false);
  const [cards, setCards] = useState<ChangeCardDto[]>([]);
  const [activeViewport, setActiveViewport] = useState<'mobile' | 'desktop'>(
    isPhone ? 'mobile' : 'desktop',
  );
  const [pagesByViewport, setPagesByViewport] = useState<
    Partial<Record<'mobile' | 'desktop', VisualDiffPageDto[]>>
  >({});
  const [screenshotsEnabled, setScreenshotsEnabled] = useState(isPhone);
  const [mergeReview, setMergeReview] = useState<MergeReviewStateDto | null>(null);
  const [excludedPaths, setExcludedPaths] = useState<Record<string, boolean>>({});
  const [loadingChanges, setLoadingChanges] = useState(true);
  const [loadingScreenshots, setLoadingScreenshots] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [publishElapsedSec, setPublishElapsedSec] = useState(0);

  useEffect(() => {
    if (!titleDirty) {
      setTitle(session.title);
    }
  }, [session.title, titleDirty]);

  const state = publishProgress?.state ?? session.publishState;
  const prUrl = publishProgress?.prUrl ?? session.prUrl;
  const errorMsg = publishProgress?.error ?? session.publishError;
  const checks: VerificationCheckResult[] = publishProgress?.checks ?? [];
  const isUndoMode = session.kind === 'revert';

  const fetchScreenshotsFor = async (vp: 'mobile' | 'desktop') => {
    setLoadingScreenshots(true);
    setScreenshotsEnabled(true);
    try {
      const rev = await api.getReview(session.id, true, vp);
      setCards(rev.cards);
      if (rev.mergeReview) setMergeReview(rev.mergeReview);
      setPagesByViewport((prev) => ({ ...prev, [vp]: rev.pages }));
    } catch {
      // ignore
    } finally {
      setLoadingScreenshots(false);
    }
  };

  const loadReview = async (opts?: { invalidateScreenshots?: boolean }) => {
    try {
      const rev = await api.getReview(session.id, false, activeViewport);
      setCards(rev.cards);
      if (rev.mergeReview) setMergeReview(rev.mergeReview);
      if (opts?.invalidateScreenshots) {
        setPagesByViewport({});
      }
      return rev;
    } catch {
      return null;
    } finally {
      setLoadingChanges(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoadingChanges(true);
    (async () => {
      // Q21: Sync when opening the Publish modal so conflicts are resolved & reviewed before publishing
      if (session.canEdit && session.kind !== 'revert') {
        try {
          const syncRes = await api.syncSession(session.id, { kind: 'publish' });
          if (active && syncRes.review) {
            setMergeReview(syncRes.review);
          }
        } catch {
          // Non-fatal in offline/dev mode
        }
      }
      if (!active) return;
      await loadReview();
      // Auto-load mobile screenshots non-blockingly on phones; desktop stays opt-in
      if (active && isPhone) {
        void fetchScreenshotsFor('mobile');
      }
    })();
    return () => {
      active = false;
    };
  }, [session.id]);

  useEffect(() => {
    if (state === 'failed_conflict') {
      void loadReview({ invalidateScreenshots: true }).then(() => {
        if (screenshotsEnabled || isPhone) {
          void fetchScreenshotsFor(activeViewport);
        }
      });
    }
  }, [state]);

  const includedCards = cards.filter((c) => !excludedPaths[c.path]);
  const hasExcludedFiles = isUndoMode && Object.values(excludedPaths).some(Boolean);
  const fileListSummary = `Updated ${includedCards.length} file${includedCards.length === 1 ? '' : 's'}: ${includedCards
    .slice(0, 4)
    .map((c) => c.path.replace(/^src\/pages\//, '').replace(/^public\//, ''))
    .join(', ')}${includedCards.length > 4 ? ` and ${includedCards.length - 4} more` : ''}.`;
  const plainSummary =
    includedCards.length === 0
      ? 'No file changes selected yet.'
      : isUndoMode && !hasExcludedFiles && session.revertReason
        ? `Undo publication: ${session.revertReason}`
        : fileListSummary;

  const hasPendingChoices = mergeReview?.status === 'needs_choices';

  const handlePublish = async () => {
    setSubmitting(true);
    try {
      let publishTitle = title.trim() || session.title;
      // Q16: For partial undo, revert any unticked files back to current main before publishing
      if (isUndoMode) {
        const toExclude = Object.entries(excludedPaths)
          .filter(([, excluded]) => excluded)
          .map(([p]) => p);
        for (const p of toExclude) {
          await api.revertFile(session.id, p);
        }
        if (toExclude.length > 0 && !titleDirty && publishTitle.startsWith('Undo: ')) {
          const base = publishTitle.slice('Undo: '.length).trim() || 'Website update';
          publishTitle = session.parentSessionId ? `Continued: ${base}` : `Adjusted: ${base}`;
        }
      }
      await api.publish(session.id, publishTitle, plainSummary);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevertFile = async (filePath: string) => {
    await api.revertFile(session.id, filePath);
    await loadReview({ invalidateScreenshots: true });
    await onChangedFilesUpdated();
    if (screenshotsEnabled || isPhone) {
      void fetchScreenshotsFor(activeViewport);
    }
  };

  const handleSelectViewport = (vp: 'mobile' | 'desktop') => {
    setActiveViewport(vp);
    if (!pagesByViewport[vp]) {
      void fetchScreenshotsFor(vp);
    }
  };

  const isInFlight =
    submitting ||
    ['verifying', 'rebasing', 'resolving_conflicts', 'pushing_pr', 'waiting_ci', 'deploying_pages'].includes(
      state,
    );
  const isFailed = ['failed_checks', 'failed_conflict', 'failed_ci'].includes(state);
  const isPublished = state === 'published';

  useEffect(() => {
    if (!isInFlight) {
      setPublishElapsedSec(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      setPublishElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isInFlight]);

  const activeStepIdx = (() => {
    if (state === 'verifying') return 0;
    if (state === 'rebasing' || state === 'resolving_conflicts') return 1;
    if (state === 'pushing_pr' || state === 'waiting_ci') return 2;
    if (state === 'deploying_pages') return 3;
    if (state === 'published') return 4;
    return -1;
  })();

  const changes = includedCards;
  const activePages = pagesByViewport[activeViewport] ?? [];
  const progressPct = isPublished
    ? 100
    : Math.min(95, Math.max(12, Math.round(((Math.max(0, activeStepIdx) + 0.5) / STEPS.length) * 100)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/35 sm:p-4 backdrop-blur-[2px]">
      <div className="flex h-dvh w-full flex-col bg-white sm:h-auto sm:max-h-[92vh] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-[#E7E5E4] sm:shadow-xl">
        <div
          className="flex shrink-0 items-center justify-between border-b border-stone-100 px-4 py-3 sm:px-6 sm:py-4"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <h2 className="text-base font-semibold text-stone-900">
            {isPublished
              ? 'Published to Live Site'
              : isUndoMode
                ? 'Review & Undo Publication'
                : 'Review & Publish Changes'}
          </h2>
          {!isInFlight && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close publish modal"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 sm:max-h-[78vh] sm:px-6 sm:py-5">
          {!isInFlight && !isPublished && (
            <>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1.5">
                  Update title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleDirty(true);
                  }}
                  className="w-full rounded-xl border border-stone-300 bg-[#FAF9F7] px-3.5 py-2 text-sm text-stone-900 outline-none focus:border-amber-600 focus:bg-white"
                />
                <p className="mt-2 text-xs text-stone-500">{plainSummary}</p>
                {isUndoMode && (
                  <p className="mt-1.5 text-[11px] text-stone-500">
                    Want to undo only part of a page? Click{' '}
                    <strong className="font-medium text-stone-700">Edit / partial undo in chat</strong>{' '}
                    below and tell Halley what to keep.
                  </p>
                )}
              </div>

              {mergeReview &&
                (mergeReview.status === 'needs_choices' ||
                  mergeReview.status === 'ready_for_review' ||
                  mergeReview.records.length > 0) && (
                  <ConflictCards
                    sessionId={session.id}
                    review={mergeReview}
                    onUpdated={(next) => {
                      setMergeReview(next);
                      void loadReview({ invalidateScreenshots: true }).then(() => {
                        if (screenshotsEnabled || isPhone) {
                          void fetchScreenshotsFor(activeViewport);
                        }
                      });
                    }}
                    onUndone={() => {
                      setMergeReview(null);
                      void loadReview({ invalidateScreenshots: true }).then(() => {
                        if (screenshotsEnabled || isPhone) {
                          void fetchScreenshotsFor(activeViewport);
                        }
                      });
                    }}
                  />
                )}

              {loadingChanges ? (
                <p className="flex items-center gap-2 text-xs text-stone-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing with live site &amp; loading changes…
                </p>
              ) : (
                <VisualReview
                  cards={cards}
                  pages={activePages}
                  isUndoMode={isUndoMode}
                  defaultShowTechnical={persona === 'developer'}
                  excludedPaths={excludedPaths}
                  onToggleInclude={(filePath, inc) =>
                    setExcludedPaths((prev) => ({ ...prev, [filePath]: !inc }))
                  }
                  onRevertFile={(filePath) => void handleRevertFile(filePath)}
                  onRequestScreenshots={() => void fetchScreenshotsFor(activeViewport)}
                  loadingScreenshots={loadingScreenshots}
                  screenshotViewport={activeViewport}
                  onSelectScreenshotViewport={handleSelectViewport}
                  screenshotsEnabled={screenshotsEnabled}
                />
              )}
            </>
          )}

          {(isInFlight || isPublished) && (
            <div className="space-y-4">
              {/* Progress summary & always-visible checklist */}
              <div className="rounded-xl border border-stone-200 bg-[#FAF9F7] p-4 space-y-4">
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-stone-900 truncate">
                        {title.trim() || (isUndoMode ? 'Undo publication' : 'Site update')}
                      </p>
                      <p className="mt-0.5 text-xs text-stone-500">{plainSummary}</p>
                    </div>
                    {!isPublished && (
                      <span className="shrink-0 rounded-full border border-stone-200 bg-white px-2.5 py-0.5 font-mono text-[11px] font-medium text-stone-600">
                        Step {Math.max(1, activeStepIdx + 1)}/{STEPS.length} · {publishElapsedSec}s
                      </span>
                    )}
                  </div>

                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        isPublished ? 'bg-emerald-600' : 'bg-amber-600'
                      }`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>

                {/* Full 5-step checklist (always shown on both mobile & desktop) */}
                <div className="space-y-3 border-t border-stone-200/80 pt-3.5">
                  {STEPS.map((step, idx) => {
                    const done = isPublished || idx < activeStepIdx;
                    const active = !isPublished && idx === activeStepIdx;
                    return (
                      <div key={step.key} className="flex items-start gap-3 text-sm">
                        <div className="mt-0.5 shrink-0">
                          {done ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          ) : active ? (
                            <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                          ) : (
                            <div className="h-4 w-4 rounded-full border border-stone-300 bg-white" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <span className={done || active ? 'font-medium text-stone-900' : 'text-stone-400'}>
                            {step.label}
                          </span>
                          {active && (
                            <p className="mt-0.5 text-xs text-stone-500">
                              {step.key === 'verifying' && publishProgress?.queueMessage
                                ? publishProgress.queueMessage
                                : step.detail}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {isPublished ? (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>Your changes are now live on the website.</span>
                  </div>
                ) : (
                  <p className="text-[11px] leading-relaxed text-stone-500">
                    Usually takes 1–2 minutes. Every page and link is checked before updating the live website.
                  </p>
                )}
              </div>

              {/* Summary of changes going live */}
              {changes.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
                    {isPublished ? `Published changes (${changes.length})` : `Changes being published (${changes.length})`}
                  </h4>
                  <div className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
                    {changes.map((card) => (
                      <div key={card.id} className="px-3.5 py-2.5 text-xs">
                        <p className="font-semibold text-stone-900">{card.title}</p>
                        <p className="mt-0.5 text-[11px] text-stone-500">{card.summary}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {isFailed && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-amber-950">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
                <div>
                  <p className="font-semibold">Couldn&apos;t publish just yet</p>
                  <p className="mt-1 text-xs text-amber-900">{errorMsg}</p>
                </div>
              </div>

              {checks.filter((c) => !c.passed).length > 0 && (
                <div className="space-y-2">
                  {checks
                    .filter((c) => !c.passed)
                    .map((c) => (
                      <div key={c.name} className="rounded-lg border border-amber-200 bg-white p-2.5 text-xs">
                        <p className="font-semibold text-stone-800">{c.name}</p>
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-stone-600">
                          {c.output}
                        </pre>
                      </div>
                    ))}
                </div>
              )}

              <button
                type="button"
                onClick={async () => {
                  const logs =
                    publishProgress?.ciLogs ||
                    checks
                      .filter((c) => !c.passed)
                      .map((c) => `${c.name}:\n${c.output}`)
                      .join('\n\n');
                  await onAskHalleyToFix(errorMsg || 'Publish checks failed', logs);
                  onClose();
                }}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-stone-800"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Ask Halley to fix
              </button>
            </div>
          )}

          {prUrl && (
            <div className="text-xs text-stone-500">
              <button
                type="button"
                onClick={() => setShowDetails(!showDetails)}
                className="underline hover:text-stone-800"
              >
                {showDetails ? 'Hide technical details' : 'Technical details'}
              </button>
              {showDetails && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
                  <span className="truncate">Branch: {session.workingBranch}</span>
                  <span>·</span>
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-amber-800 hover:underline"
                  >
                    View on GitHub <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>

        <div
          className="flex shrink-0 items-center justify-end gap-2.5 border-t border-stone-100 bg-white px-4 py-3 sm:px-6 sm:py-4"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          {isPublished ? (
            <button
              type="button"
              onClick={onStartNewEdit}
              className="min-h-[42px] rounded-xl bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-800"
            >
              Start new edit
            </button>
          ) : (
            <>
              {!isInFlight && isUndoMode && (
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-stone-200 bg-white px-3.5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
                >
                  <MessageSquare className="h-4 w-4 text-stone-500" />
                  Edit / partial undo in chat
                </button>
              )}
              {!isInFlight && !isUndoMode && (
                <button
                  type="button"
                  onClick={onClose}
                  className="min-h-[42px] rounded-xl px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
                >
                  Close
                </button>
              )}
              <button
                type="button"
                disabled={isInFlight || changes.length === 0 || hasPendingChoices}
                onClick={handlePublish}
                className="min-h-[42px] rounded-xl bg-stone-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:opacity-40"
              >
                {isInFlight
                  ? 'Publishing…'
                  : isUndoMode && !hasExcludedFiles
                    ? 'Publish Undo to Live Site'
                    : isUndoMode && hasExcludedFiles
                      ? 'Publish Selected Changes'
                      : 'Publish to Live Site'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
