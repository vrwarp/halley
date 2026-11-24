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

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'verifying', label: 'Checking links, SEO & page build' },
  { key: 'rebasing', label: 'Syncing with current live website' },
  { key: 'waiting_ci', label: 'Verifying on GitHub' },
  { key: 'deploying_pages', label: 'Live on GitHub ✓ — deploying to website (~1 min)' },
  { key: 'published', label: 'Published to Live Site ✓' },
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
  const [title, setTitle] = useState(session.title);
  const [cards, setCards] = useState<ChangeCardDto[]>([]);
  const [pages, setPages] = useState<VisualDiffPageDto[]>([]);
  const [mergeReview, setMergeReview] = useState<MergeReviewStateDto | null>(null);
  const [excludedPaths, setExcludedPaths] = useState<Record<string, boolean>>({});
  const [loadingChanges, setLoadingChanges] = useState(true);
  const [loadingScreenshots, setLoadingScreenshots] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const state = publishProgress?.state ?? session.publishState;
  const prUrl = publishProgress?.prUrl ?? session.prUrl;
  const errorMsg = publishProgress?.error ?? session.publishError;
  const checks: VerificationCheckResult[] = publishProgress?.checks ?? [];
  const isUndoMode = session.kind === 'revert';

  const loadReview = async (withScreenshots = false) => {
    if (withScreenshots) setLoadingScreenshots(true);
    try {
      const rev = await api.getReview(session.id, withScreenshots);
      setCards(rev.cards);
      if (rev.pages.length > 0) setPages(rev.pages);
      if (rev.mergeReview) setMergeReview(rev.mergeReview);
    } catch {
      // ignore
    } finally {
      setLoadingChanges(false);
      setLoadingScreenshots(false);
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
      if (active) {
        await loadReview(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [session.id]);

  useEffect(() => {
    if (state === 'failed_conflict') {
      void loadReview(false);
    }
  }, [state]);

  const includedCards = cards.filter((c) => !excludedPaths[c.path]);
  const plainSummary =
    includedCards.length === 0
      ? 'No file changes selected yet.'
      : isUndoMode && session.revertReason
        ? `Undo publication: ${session.revertReason}`
        : `Updated ${includedCards.length} file${includedCards.length === 1 ? '' : 's'}: ${includedCards
            .slice(0, 4)
            .map((c) => c.path.replace(/^src\/pages\//, '').replace(/^public\//, ''))
            .join(', ')}${includedCards.length > 4 ? ` and ${includedCards.length - 4} more` : ''}.`;

  const hasPendingChoices = mergeReview?.status === 'needs_choices';

  const handlePublish = async () => {
    setSubmitting(true);
    try {
      // Q16: For partial undo, revert any unticked files back to current main before publishing
      if (isUndoMode) {
        const toExclude = Object.entries(excludedPaths)
          .filter(([, excluded]) => excluded)
          .map(([p]) => p);
        for (const p of toExclude) {
          await api.revertFile(session.id, p);
        }
      }
      await api.publish(session.id, title.trim() || session.title, plainSummary);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevertFile = async (filePath: string) => {
    await api.revertFile(session.id, filePath);
    await loadReview(false);
    await onChangedFilesUpdated();
  };

  const isInFlight =
    submitting ||
    ['verifying', 'rebasing', 'resolving_conflicts', 'pushing_pr', 'waiting_ci', 'deploying_pages'].includes(
      state,
    );
  const isFailed = ['failed_checks', 'failed_conflict', 'failed_ci'].includes(state);
  const isPublished = state === 'published';

  const activeStepIdx = (() => {
    if (state === 'verifying') return 0;
    if (state === 'rebasing' || state === 'resolving_conflicts') return 1;
    if (state === 'pushing_pr' || state === 'waiting_ci') return 2;
    if (state === 'deploying_pages') return 3;
    if (state === 'published') return 4;
    return -1;
  })();

  const changes = includedCards;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/35 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-3xl rounded-2xl border border-[#E7E5E4] bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-100 px-6 py-4">
          <h2 className="text-base font-semibold text-stone-900">
            {isPublished
              ? 'Published to Live Site'
              : isUndoMode
                ? 'Review & Undo Publication'
                : 'Review & Publish Changes'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[78vh] overflow-y-auto px-6 py-5 space-y-5">
          {!isInFlight && !isPublished && (
            <>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1.5">
                  Update title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-xl border border-stone-300 bg-[#FAF9F7] px-3.5 py-2 text-sm text-stone-900 outline-none focus:border-amber-600 focus:bg-white"
                />
                <p className="mt-2 text-xs text-stone-500">{plainSummary}</p>
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
                      void loadReview(false);
                    }}
                    onUndone={() => {
                      setMergeReview(null);
                      void loadReview(false);
                    }}
                  />
                )}

              {loadingChanges ? (
                <p className="flex items-center gap-2 text-xs text-stone-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing with live site & loading visual review…
                </p>
              ) : (
                <VisualReview
                  cards={cards}
                  pages={pages}
                  isUndoMode={isUndoMode}
                  defaultShowTechnical={persona === 'developer'}
                  excludedPaths={excludedPaths}
                  onToggleInclude={(filePath, inc) =>
                    setExcludedPaths((prev) => ({ ...prev, [filePath]: !inc }))
                  }
                  onRevertFile={(filePath) => void handleRevertFile(filePath)}
                  onRequestScreenshots={() => void loadReview(true)}
                  loadingScreenshots={loadingScreenshots}
                />
              )}
            </>
          )}

          {(isInFlight || isPublished) && (
            <div className="space-y-3 rounded-xl border border-stone-200 bg-[#FAF9F7] p-4">
              {STEPS.map((step, idx) => {
                const done = isPublished || idx < activeStepIdx;
                const active = !isPublished && idx === activeStepIdx;
                return (
                  <div key={step.key} className="flex items-center gap-3 text-sm">
                    {done ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    ) : active ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-600" />
                    ) : (
                      <div className="h-4 w-4 shrink-0 rounded-full border border-stone-300 bg-white" />
                    )}
                    <span className={done || active ? 'font-medium text-stone-900' : 'text-stone-400'}>
                      {step.label}
                    </span>
                  </div>
                );
              })}
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
                className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-stone-800"
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
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
                  <span>Branch: {session.workingBranch}</span>
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

        <div className="flex items-center justify-end gap-2.5 border-t border-stone-100 px-6 py-4">
          {isPublished ? (
            <button
              type="button"
              onClick={onStartNewEdit}
              className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-800"
            >
              Start new edit
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
              >
                Close
              </button>
              <button
                type="button"
                disabled={isInFlight || changes.length === 0 || hasPendingChoices}
                onClick={handlePublish}
                className="rounded-xl bg-stone-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:opacity-40"
              >
                {isInFlight
                  ? 'Publishing…'
                  : isUndoMode
                    ? 'Publish Undo to Live Site'
                    : 'Publish to Live Site'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
