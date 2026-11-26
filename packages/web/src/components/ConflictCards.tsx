import type { EscalationEstimateDto, MergeReviewStateDto } from '@halley/shared';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.js';

interface Props {
  sessionId: string;
  review: MergeReviewStateDto;
  onUpdated: (review: MergeReviewStateDto) => void;
  onUndone?: () => void;
}

export function ConflictCards({ sessionId, review, onUpdated, onUndone }: Props) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Improve this merge..." escalation dialog state (Q9-Q11)
  const [showImprove, setShowImprove] = useState(false);
  const [improveIds, setImproveIds] = useState<Record<string, boolean>>({});
  const [improveNote, setImproveNote] = useState('');
  const [estimate, setEstimate] = useState<EscalationEstimateDto | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [advancedPicks, setAdvancedPicks] = useState<Record<string, 'advanced' | 'first'>>({});

  const pendingRecords = review.records.filter((r) => r.status === 'needs_choice');

  const handleApplyChoices = async () => {
    const missingCustom = pendingRecords.find((r) => {
      const opt = selected[r.id] || r.options?.[0]?.id || 'theirs';
      return opt === 'custom' && !(customText[r.id] || '').trim();
    });
    if (missingCustom) {
      setError('Please describe what you want in the "Something else…" box before applying.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const choices = pendingRecords.map((r) => {
        const opt = selected[r.id] || r.options?.[0]?.id || 'theirs';
        return {
          recordId: r.id,
          optionId: opt,
          ...(opt === 'custom' ? { customInstruction: (customText[r.id] || '').trim() } : {}),
        };
      });
      const res = await api.chooseSyncConflicts(sessionId, choices);
      onUpdated(res.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply choices');
    } finally {
      setSubmitting(false);
    }
  };

  const openImproveDialog = async (focusRecordId?: string) => {
    const initial: Record<string, boolean> = {};
    for (const r of review.records) {
      initial[r.id] = focusRecordId ? r.id === focusRecordId : true;
    }
    setImproveIds(initial);
    setShowImprove(true);
    setEstimating(true);
    setError(null);
    try {
      const recordIds = Object.entries(initial)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const res = await api.estimateEscalation(sessionId, { recordIds, userNote: improveNote });
      setEstimate(res.estimate);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to estimate cost');
    } finally {
      setEstimating(false);
    }
  };

  const refreshEstimate = async (nextIds: Record<string, boolean>, note: string) => {
    setEstimating(true);
    try {
      const recordIds = Object.entries(nextIds)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const res = await api.estimateEscalation(sessionId, { recordIds, userNote: note });
      setEstimate(res.estimate);
    } finally {
      setEstimating(false);
    }
  };

  const handleRunAdvanced = async () => {
    setEscalating(true);
    setError(null);
    try {
      const recordIds = Object.entries(improveIds)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const res = await api.escalateMerge(sessionId, {
        recordIds,
        userNote: improveNote,
        ceilingUsd: estimate ? Math.min(estimate.upToUsd, estimate.hardCeilingUsd) : 2,
      });
      const defaults: Record<string, 'advanced' | 'first'> = {};
      for (const r of res.review.advancedAttempt?.records ?? []) {
        defaults[r.path] = 'advanced';
      }
      setAdvancedPicks(defaults);
      setShowImprove(false);
      onUpdated(res.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Advanced merge failed');
    } finally {
      setEscalating(false);
    }
  };

  const handleApplyAdvancedPicks = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const picks = Object.entries(advancedPicks).map(([path, use]) => ({ path, use }));
      const res = await api.applyAdvancedMerge(sessionId, picks);
      onUpdated(res.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply advanced merge');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUndoSync = async () => {
    setSubmitting(true);
    try {
      await api.undoSync(sessionId, review.preSyncSha);
      onUndone?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
        <div>
          <p className="text-xs font-semibold text-stone-900">{review.summary}</p>
          {review.upstreamCommits.length > 0 && (
            <p className="mt-0.5 text-[11px] text-stone-500">
              Latest live updates:{' '}
              {review.upstreamCommits
                .slice(0, 3)
                .map((u) => `${u.subject} (${u.author})`)
                .join(' · ')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {review.records.length > 0 && review.status !== 'needs_choices' && (
            <button
              type="button"
              onClick={() => void openImproveDialog()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Improve this merge…
            </button>
          )}
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleUndoSync()}
            className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Undo update
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Pending user choices (at most 3 options + "Something else...") */}
      {pendingRecords.map((rec) => {
        const chosen = selected[rec.id] || rec.options?.[0]?.id || 'theirs';
        return (
          <div key={rec.id} className="rounded-xl border border-amber-200 bg-white p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                  <AlertTriangle className="h-3 w-3" /> Your choice needed
                </span>
                <p className="mt-1.5 text-sm font-medium text-stone-900">{rec.explanation}</p>
                {rec.affectedRoute && (
                  <p className="text-[11px] text-stone-500">Page: {rec.affectedRoute}</p>
                )}
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {(rec.options ?? []).slice(0, 3).map((opt) => {
                const active = chosen === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setSelected((p) => ({ ...p, [rec.id]: opt.id }));
                      setCustomOpen((p) => ({ ...p, [rec.id]: false }));
                    }}
                    className={`rounded-lg border p-3 text-left transition ${
                      active
                        ? 'border-stone-900 bg-stone-50 ring-1 ring-stone-900'
                        : 'border-stone-200 bg-white hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-semibold text-stone-900">{opt.label}</span>
                      {opt.recommended && (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-stone-600">{opt.description}</p>
                    {opt.previewText && (
                      <p className="mt-2 line-clamp-3 rounded bg-stone-100 px-2 py-1.5 font-mono text-[11px] text-stone-700">
                        {opt.previewText}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>

            {/* "Something else..." free-text escape (Q7) */}
            <div>
              <button
                type="button"
                onClick={() => {
                  const nextOpen = !customOpen[rec.id];
                  setCustomOpen((p) => ({ ...p, [rec.id]: nextOpen }));
                  setSelected((p) => {
                    if (nextOpen) return { ...p, [rec.id]: 'custom' };
                    const copy = { ...p };
                    if (copy[rec.id] === 'custom') delete copy[rec.id];
                    return copy;
                  });
                }}
                className="text-xs font-medium text-stone-600 underline hover:text-stone-900"
              >
                Something else…
              </button>
              {customOpen[rec.id] && (
                <textarea
                  rows={2}
                  value={customText[rec.id] || ''}
                  onChange={(e) => {
                    setCustomText((p) => ({ ...p, [rec.id]: e.target.value }));
                    setSelected((p) => ({ ...p, [rec.id]: 'custom' }));
                  }}
                  placeholder='Tell Halley what you want (e.g. "use Grace&#39;s date with my wording")'
                  className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2 text-xs focus:border-stone-900 focus:outline-none"
                />
              )}
            </div>
          </div>
        );
      })}

      {pendingRecords.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleApplyChoices()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-4 py-2 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Apply choices & combine
          </button>
        </div>
      )}

      {/* Side-by-side First vs Advanced comparison (Q9-Q11) */}
      {review.advancedAttempt && (
        <div className="rounded-xl border border-amber-300 bg-amber-50/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-stone-900">
                Advanced Merge Comparison (${review.advancedAttempt.usageUsd.toFixed(2)} used)
              </p>
              <p className="text-[11px] text-stone-600">{review.advancedAttempt.message}</p>
            </div>
          </div>

          {!review.advancedAttempt.identicalToFirst && !review.advancedAttempt.stoppedAtCeiling && (
            <>
              <div className="space-y-2">
                {review.advancedAttempt.records.map((adv) => {
                  const first = review.records.find((r) => r.path === adv.path);
                  const pick = advancedPicks[adv.path] ?? 'advanced';
                  return (
                    <div key={adv.path} className="rounded-lg border border-stone-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-stone-800">
                          {adv.affectedRoute || adv.path}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setAdvancedPicks((p) => ({ ...p, [adv.path]: 'first' }))}
                            className={`rounded px-2 py-1 text-[11px] font-medium ${
                              pick === 'first'
                                ? 'bg-stone-900 text-white'
                                : 'border border-stone-200 text-stone-700'
                            }`}
                          >
                            Keep first
                          </button>
                          <button
                            type="button"
                            onClick={() => setAdvancedPicks((p) => ({ ...p, [adv.path]: 'advanced' }))}
                            className={`rounded px-2 py-1 text-[11px] font-medium ${
                              pick === 'advanced'
                                ? 'bg-amber-700 text-white'
                                : 'border border-stone-200 text-stone-700'
                            }`}
                          >
                            Use advanced
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2 text-[11px]">
                        <div className="rounded bg-stone-50 p-2">
                          <p className="font-semibold text-stone-500">First attempt</p>
                          <p className="mt-1 text-stone-700">{first?.explanation}</p>
                        </div>
                        <div className="rounded bg-amber-50 p-2">
                          <p className="font-semibold text-amber-800">Advanced attempt</p>
                          <p className="mt-1 text-stone-800">{adv.explanation}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleApplyAdvancedPicks()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-stone-800"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Apply selected results
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Improve this merge dialog */}
      {showImprove && (
        <div className="rounded-xl border border-stone-300 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-stone-900">Improve this merge (Advanced model)</h4>
            <button
              type="button"
              onClick={() => setShowImprove(false)}
              className="text-xs text-stone-500 hover:text-stone-900"
            >
              Cancel
            </button>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-stone-600">Which conflicts should Advanced redo?</p>
            {review.records.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-xs text-stone-800">
                <input
                  type="checkbox"
                  checked={Boolean(improveIds[r.id])}
                  onChange={(e) => {
                    const next = { ...improveIds, [r.id]: e.target.checked };
                    setImproveIds(next);
                    void refreshEstimate(next, improveNote);
                  }}
                />
                <span>
                  {r.affectedRoute || r.path} — <span className="text-stone-500">{r.explanation}</span>
                </span>
              </label>
            ))}
          </div>

          <div>
            <label className="block text-[11px] font-medium text-stone-600">
              What looked wrong? (optional)
            </label>
            <input
              type="text"
              value={improveNote}
              onChange={(e) => setImproveNote(e.target.value)}
              placeholder='e.g. "It dropped Grace&#39;s new service time"'
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-1.5 text-xs"
            />
          </div>

          {estimating ? (
            <p className="flex items-center gap-1.5 text-xs text-stone-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Estimating cost…
            </p>
          ) : estimate ? (
            <div className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-700 space-y-1">
              <p>
                <strong>
                  About ${estimate.aboutUsd.toFixed(2)} (up to $
                  {Math.min(estimate.upToUsd, estimate.hardCeilingUsd).toFixed(2)})
                </strong>{' '}
                · {estimate.modelLabel} model · today&apos;s remaining budget: $
                {estimate.remainingBudgetUsd.toFixed(2)}
              </p>
              {estimate.exceedsCeiling && (
                <p className="text-amber-800">
                  Estimate exceeds the ${estimate.hardCeilingUsd.toFixed(2)} per-run cap — consider
                  unchecking conflicts that already look fine.
                </p>
              )}
              {!estimate.canAfford && (
                <p className="text-red-700">
                  Not enough daily budget remaining. Ask an admin to grant extra allowance.
                </p>
              )}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowImprove(false)}
              className="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={escalating || estimating || !estimate?.canAfford}
              onClick={() => void handleRunAdvanced()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-50"
            >
              {escalating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Run with Advanced model
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
