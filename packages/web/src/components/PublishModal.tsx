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
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  processVisualDiffPageClient,
  renderFullDiffClient,
  revokeObjectUrls,
} from '../lib/perceptual-diff-client.js';
import { isTransientPublishError, resolvePublishedSiteUrl } from '../lib/publish-helpers.js';
import { ConflictCards } from './ConflictCards.js';
import { VisualReview } from './VisualReview.js';
import { reportIgnored } from '../lib/retry.js';

interface Props {
  session: EditorSessionDto;
  persona?: 'non-technical' | 'developer';
  currentRoute?: string;
  publishProgress: PublishProgressPayload | null;
  onClose: () => void;
  onAskHalleyToFix: (summary: string, logs?: string) => Promise<void>;
  onStartNewEdit: () => void;
  onChangedFilesUpdated: () => Promise<void>;
}

const STEPS: Array<{ key: string; label: string; detail: string }> = [
  {
    key: 'rebasing',
    label: 'Syncing with current live website',
    detail: 'Making sure your draft stays in sync with any recent live updates.',
  },
  {
    key: 'verifying',
    label: 'Checking links, SEO & page build',
    detail: 'Building every page and checking links, images, and SEO.',
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
  currentRoute,
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
  const [targetRoutes, setTargetRoutes] = useState<string[]>([]);
  const [activeViewport, setActiveViewport] = useState<'mobile' | 'desktop'>(
    isPhone ? 'mobile' : 'desktop',
  );
  const [pagesByViewport, setPagesByViewport] = useState<
    Record<'mobile' | 'desktop', Record<string, VisualDiffPageDto>>
  >({ mobile: {}, desktop: {} });
  const [fullPagesByViewport, setFullPagesByViewport] = useState<
    Record<'mobile' | 'desktop', Record<string, VisualDiffPageDto>>
  >({ mobile: {}, desktop: {} });
  const [loadingRoutesByViewport, setLoadingRoutesByViewport] = useState<
    Record<'mobile' | 'desktop', Record<string, boolean>>
  >({ mobile: {}, desktop: {} });
  const [mergeReview, setMergeReview] = useState<MergeReviewStateDto | null>(null);
  const [excludedPaths, setExcludedPaths] = useState<Record<string, boolean>>({});
  const [loadingChanges, setLoadingChanges] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retryingDeploy, setRetryingDeploy] = useState(false);
  const [publishElapsedSec, setPublishElapsedSec] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const objectUrlsRef = useRef<string[]>([]);
  const rawUrlsRef = useRef<
    Record<'mobile' | 'desktop', Record<string, { draft?: string; live?: string }>>
  >({ mobile: {}, desktop: {} });

  useEffect(() => {
    if (!titleDirty) {
      setTitle(session.title);
    }
  }, [session.title, titleDirty]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      revokeObjectUrls(objectUrlsRef.current);
      objectUrlsRef.current = [];
    };
  }, []);

  const state = publishProgress?.state ?? session.publishState;
  const prUrl = publishProgress?.prUrl ?? session.prUrl;
  const deployUrl = publishProgress?.deployUrl ?? null;
  const errorMsg = publishProgress?.error ?? session.publishError;
  const checks: VerificationCheckResult[] = publishProgress?.checks ?? [];
  const isUndoMode = session.kind === 'revert';

  const resetScreenshotCache = () => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    revokeObjectUrls(objectUrlsRef.current);
    objectUrlsRef.current = [];
    rawUrlsRef.current = { mobile: {}, desktop: {} };
    setPagesByViewport({ mobile: {}, desktop: {} });
    setFullPagesByViewport({ mobile: {}, desktop: {} });
    setLoadingRoutesByViewport({ mobile: {}, desktop: {} });
  };

  const fetchRoutesForViewport = (vp: 'mobile' | 'desktop', routes: string[]) => {
    if (routes.length === 0) return;
    const gen = generationRef.current;
    if (!abortRef.current || abortRef.current.signal.aborted) {
      abortRef.current = new AbortController();
    }
    const signal = abortRef.current.signal;

    setLoadingRoutesByViewport((prev) => {
      const nextVp = { ...prev[vp] };
      for (const r of routes) nextVp[r] = true;
      return { ...prev, [vp]: nextVp };
    });

    for (const route of routes) {
      void api
        .getReviewScreenshot(session.id, { route, viewport: vp, signal })
        .then(async ({ page }) => {
          if (generationRef.current !== gen || signal.aborted) return;
          const processed = await processVisualDiffPageClient(page, vp);
          if (generationRef.current !== gen || signal.aborted) {
            revokeObjectUrls(processed.objectUrls);
            return;
          }
          objectUrlsRef.current.push(...processed.objectUrls);
          rawUrlsRef.current[vp][route] = {
            draft: processed.rawDraftUrl,
            live: processed.rawLiveUrl,
          };
          setPagesByViewport((prev) => ({
            ...prev,
            [vp]: { ...prev[vp], [route]: processed.croppedPage },
          }));
          setFullPagesByViewport((prev) => ({
            ...prev,
            [vp]: { ...prev[vp], [route]: processed.fullPage },
          }));
        })
        .catch((err) => {
          // Aborts (modal closed / viewport switched) or a transient per-route error: that route
          // just shows no diff.
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            reportIgnored(err, `screenshot diff failed for ${route}`);
          }
        })
        .finally(() => {
          if (generationRef.current !== gen) return;
          setLoadingRoutesByViewport((prev) => ({
            ...prev,
            [vp]: { ...prev[vp], [route]: false },
          }));
        });
    }
  };

  const handleRequestFullDiff = (route: string) => {
    const vp = activeViewport;
    const existing = fullPagesByViewport[vp][route];
    if (existing?.shots?.[vp]?.diffScreenshotDataUrl) return;
    const raw = rawUrlsRef.current[vp][route];
    if (!raw?.draft || !raw?.live) return;

    const gen = generationRef.current;
    void renderFullDiffClient(raw.draft, raw.live).then((res) => {
      if (!res) return;
      if (generationRef.current !== gen) {
        URL.revokeObjectURL(res.objectUrl);
        return;
      }
      objectUrlsRef.current.push(res.objectUrl);
      setFullPagesByViewport((prev) => {
        const cur = prev[vp][route];
        if (!cur) return prev;
        const curShot = cur.shots?.[vp];
        return {
          ...prev,
          [vp]: {
            ...prev[vp],
            [route]: {
              ...cur,
              shots: {
                ...cur.shots,
                [vp]: {
                  ...(curShot ?? { highlights: cur.highlights }),
                  diffScreenshotDataUrl: res.diffUrl,
                },
              },
            },
          },
        };
      });
    });
  };

  const loadReview = async (opts?: { invalidateScreenshots?: boolean }) => {
    try {
      const rev = await api.getReview(session.id, false, activeViewport, currentRoute);
      setCards(rev.cards);
      if (rev.mergeReview) setMergeReview(rev.mergeReview);
      const resolvedRoutes =
        rev.targetRoutes && rev.targetRoutes.length > 0
          ? rev.targetRoutes
          : [
              ...new Set([
                ...rev.cards.map((c) => c.route || '/'),
                ...(rev.cards.length === 0 ? [currentRoute || '/'] : []),
              ]),
            ].slice(0, 4);
      setTargetRoutes(resolvedRoutes);
      if (opts?.invalidateScreenshots) {
        resetScreenshotCache();
      }
      return { rev, routes: resolvedRoutes };
    } catch (err) {
      console.warn('[halley] loading publish review failed', err);
      return null;
    } finally {
      setLoadingChanges(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoadingChanges(true);
    (async () => {
      // Virtual $0 preflight: silently applies clean non-overlapping upstream merges without
      // spending AI tokens or writing conflict markers on disk before the user clicks Publish.
      if (session.canEdit && session.kind !== 'revert') {
        try {
          const syncRes = await api.syncSession(session.id, {
            kind: 'publish',
            autoApplyCleanOnly: true,
          });
          if (active && syncRes.review) {
            setMergeReview(syncRes.review);
            if (!syncRes.review.alreadyUpToDate) {
              void onChangedFilesUpdated();
            }
          }
        } catch (err) {
          // Non-fatal in offline/dev mode: the merge review is optional.
          reportIgnored(err, 'publish pre-sync review unavailable');
        }
      }
      if (!active) return;
      const loaded = await loadReview();
      // Auto-load cropped screenshots progressively on both mobile and desktop
      if (active && loaded && loaded.routes.length > 0) {
        fetchRoutesForViewport(isPhone ? 'mobile' : 'desktop', loaded.routes);
      }
    })();
    return () => {
      active = false;
    };
  }, [session.id]);

  useEffect(() => {
    if (state === 'failed_conflict') {
      void loadReview({ invalidateScreenshots: true }).then((loaded) => {
        if (loaded && loaded.routes.length > 0) {
          fetchRoutesForViewport(activeViewport, loaded.routes);
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
    abortRef.current?.abort();
    setSubmitting(true);
    try {
      let publishTitle = title.trim() || session.title;
      const toExclude = isUndoMode
        ? Object.entries(excludedPaths)
            .filter(([, excluded]) => excluded)
            .map(([p]) => p)
        : [];
      if (toExclude.length > 0 && !titleDirty && publishTitle.startsWith('Undo: ')) {
        const base = publishTitle.slice('Undo: '.length).trim() || 'Website update';
        publishTitle = session.parentSessionId ? `Continued: ${base}` : `Adjusted: ${base}`;
      }
      await api.publish(session.id, publishTitle, plainSummary, {
        excludePaths: toExclude.length > 0 ? toExclude : undefined,
        background: true,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevertFile = async (filePath: string) => {
    await api.revertFile(session.id, filePath);
    const loaded = await loadReview({ invalidateScreenshots: true });
    await onChangedFilesUpdated();
    if (loaded && loaded.routes.length > 0) {
      fetchRoutesForViewport(activeViewport, loaded.routes);
    }
  };

  const handleSelectViewport = (vp: 'mobile' | 'desktop') => {
    setActiveViewport(vp);
    const missing = targetRoutes.filter(
      (r) => !pagesByViewport[vp][r] && !loadingRoutesByViewport[vp][r],
    );
    if (missing.length > 0) {
      fetchRoutesForViewport(vp, missing);
    }
  };

  const handleRetryDeploy = async () => {
    setRetryingDeploy(true);
    try {
      await api.retryDeploy(session.id);
      await onChangedFilesUpdated();
    } finally {
      setRetryingDeploy(false);
    }
  };

  const isDeployingPages = state === 'deploying_pages';
  const isInFlight =
    submitting ||
    retryingDeploy ||
    ['verifying', 'rebasing', 'resolving_conflicts', 'pushing_pr', 'waiting_ci', 'deploying_pages'].includes(
      state,
    );
  const isDeployFailed =
    state === 'failed_deploy' ||
    (state === 'failed_ci' && (session.status === 'merged' || Boolean(session.mergedSha)));
  const isFailed =
    !isDeployFailed && ['failed_checks', 'failed_conflict', 'failed_ci'].includes(state);
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
    if (state === 'rebasing' || state === 'resolving_conflicts') return 0;
    if (state === 'verifying') return 1;
    if (state === 'pushing_pr' || state === 'waiting_ci') return 2;
    if (state === 'deploying_pages') return 3;
    if (state === 'published') return 4;
    return -1;
  })();

  const changes = includedCards;
  const liveSiteUrl = publishProgress?.liveSiteUrl ?? session.liveSiteUrl ?? null;
  const changedCardRoutes = changes.map((c) => c.route).filter((r): r is string => Boolean(r));
  const publishedSiteUrl = resolvePublishedSiteUrl(
    liveSiteUrl,
    changedCardRoutes.length > 0 ? changedCardRoutes : targetRoutes,
  );
  const isTransientFailure = isTransientPublishError(publishProgress?.retryable, errorMsg);
  const activePagesMap = pagesByViewport[activeViewport];
  const activeLoadingRoutes = loadingRoutesByViewport[activeViewport];
  const activeFullPagesMap = fullPagesByViewport[activeViewport];
  const activePages = targetRoutes
    .map((r) => activePagesMap[r])
    .filter((p): p is VisualDiffPageDto => Boolean(p));
  const anyScreenshotsLoading = Object.values(activeLoadingRoutes).some(Boolean);
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
              : isDeployFailed
                ? 'Deploy Verification Needed'
                : isUndoMode
                  ? 'Review & Undo Publication'
                  : 'Review & Publish Changes'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close publish modal"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 sm:max-h-[78vh] sm:px-6 sm:py-5">
          {!isInFlight && !isPublished && !isDeployFailed && (
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
                      void onChangedFilesUpdated();
                      void loadReview({ invalidateScreenshots: true }).then((loaded) => {
                        if (loaded && loaded.routes.length > 0) {
                          fetchRoutesForViewport(activeViewport, loaded.routes);
                        }
                      });
                    }}
                    onUndone={() => {
                      setMergeReview(null);
                      void onChangedFilesUpdated();
                      void loadReview({ invalidateScreenshots: true }).then((loaded) => {
                        if (loaded && loaded.routes.length > 0) {
                          fetchRoutesForViewport(activeViewport, loaded.routes);
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
                  targetRoutes={targetRoutes}
                  loadingRoutes={activeLoadingRoutes}
                  fullPagesByRoute={activeFullPagesMap}
                  onRequestFullDiff={handleRequestFullDiff}
                  isUndoMode={isUndoMode}
                  defaultShowTechnical={persona === 'developer'}
                  excludedPaths={excludedPaths}
                  onToggleInclude={(filePath, inc) =>
                    setExcludedPaths((prev) => ({ ...prev, [filePath]: !inc }))
                  }
                  onRevertFile={(filePath) => void handleRevertFile(filePath)}
                  onRequestScreenshots={() => fetchRoutesForViewport(activeViewport, targetRoutes)}
                  loadingScreenshots={anyScreenshotsLoading}
                  screenshotViewport={activeViewport}
                  onSelectScreenshotViewport={handleSelectViewport}
                  screenshotsEnabled={true}
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
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                      <span>Your changes are now live on the website.</span>
                    </div>
                    {publishedSiteUrl && (
                      <a
                        href={publishedSiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex shrink-0 items-center gap-1 font-semibold text-emerald-800 underline decoration-emerald-400 underline-offset-2 hover:text-emerald-950"
                      >
                        Visit website
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
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

          {isDeployFailed && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-amber-950">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
                <div>
                  <p className="font-semibold">Live on GitHub — couldn&apos;t confirm website deploy yet</p>
                  <p className="mt-1 text-xs text-amber-900">
                    {errorMsg ||
                      'Your changes are merged on GitHub, but Halley could not confirm the live website deployment yet.'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={retryingDeploy}
                  onClick={() => void handleRetryDeploy()}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${retryingDeploy ? 'animate-spin' : ''}`} />
                  {retryingDeploy ? 'Checking…' : 'Retry deploy check'}
                </button>
                {(deployUrl || prUrl) && (
                  <a
                    href={deployUrl || prUrl || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3.5 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-100/60"
                  >
                    {deployUrl ? 'View deploy run on GitHub' : 'View on GitHub'}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          )}

          {isFailed && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-amber-950">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
                <div>
                  <p className="font-semibold">
                    {isTransientFailure
                      ? 'GitHub had a temporary hiccup'
                      : "Couldn't publish just yet"}
                  </p>
                  <p className="mt-1 text-xs text-amber-900">
                    {errorMsg ||
                      (isTransientFailure
                        ? 'Your edits are safe — please try publishing again in a moment.'
                        : 'Something went wrong while publishing your changes.')}
                  </p>
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

              <div className="flex flex-wrap items-center gap-2">
                {isTransientFailure ? (
                  <>
                    <button
                      type="button"
                      disabled={isInFlight || changes.length === 0 || hasPendingChoices}
                      onClick={() => void handlePublish()}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isInFlight ? 'animate-spin' : ''}`} />
                      Try publishing again
                    </button>
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
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3.5 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-100/60"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Ask Halley to fix
                    </button>
                  </>
                ) : (
                  <>
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
                    <button
                      type="button"
                      disabled={isInFlight || changes.length === 0 || hasPendingChoices}
                      onClick={() => void handlePublish()}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3.5 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-100/60 disabled:opacity-40"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isInFlight ? 'animate-spin' : ''}`} />
                      Try publishing again
                    </button>
                  </>
                )}
              </div>
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
          ) : isDeployingPages ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="min-h-[42px] rounded-xl px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
              >
                Close
              </button>
              <button
                type="button"
                onClick={onStartNewEdit}
                className="min-h-[42px] rounded-xl bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-800"
              >
                Start new edit
              </button>
            </>
          ) : isDeployFailed ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="min-h-[42px] rounded-xl px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
              >
                Close
              </button>
              <button
                type="button"
                disabled={retryingDeploy}
                onClick={() => void handleRetryDeploy()}
                className="min-h-[42px] rounded-xl bg-stone-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:opacity-40"
              >
                {retryingDeploy ? 'Checking…' : 'Retry deploy check'}
              </button>
            </>
          ) : (
            <>
              {isInFlight ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="min-h-[42px] rounded-xl px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
                >
                  Continue in background
                </button>
              ) : isUndoMode ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-stone-200 bg-white px-3.5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
                >
                  <MessageSquare className="h-4 w-4 text-stone-500" />
                  Edit / partial undo in chat
                </button>
              ) : (
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
