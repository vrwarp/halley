import type {
  AstroAuditReportDto,
  OptimizationFindingDto,
  OptimizationPillar,
  OptimizeAiEstimateDto,
} from '@halley/shared';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileCode2,
  Loader2,
  RefreshCw,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { reportIgnored } from '../lib/retry.js';

interface Props {
  onOpenSession: (id: string) => void;
  onSpendChanged?: () => void;
  autoFocus?: boolean;
}

const PILLAR_META: Record<
  OptimizationPillar,
  { label: string; shortDesc: string }
> = {
  inline_edit: {
    label: '$0 Inline Editability',
    shortDesc: 'Direct click-to-type text without AI turns',
  },
  agent_context: {
    label: 'Haiku Context & Hops',
    shortDesc: 'Modular files & 1-hop edits under 64K tokens',
  },
  source_mapping: {
    label: 'Source Mapping & Islands',
    shortDesc: 'Clean Astro DOM lineage & zero-JS templates',
  },
  guardrails: {
    label: 'Guardrails & Schemas',
    shortDesc: 'AGENTS.md rules, Zod schemas & SEO checks',
  },
  speed_and_ci: {
    label: 'Build, Assets & CI Speed',
    shortDesc: 'WebP assets, single-job deploy & git hygiene',
  },
};

const PILLAR_ORDER: OptimizationPillar[] = [
  'inline_edit',
  'agent_context',
  'source_mapping',
  'guardrails',
  'speed_and_ci',
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function scoreTone(score: number): {
  ring: string;
  text: string;
  badge: string;
  label: string;
} {
  if (score >= 90) {
    return {
      ring: 'border-emerald-200 bg-emerald-50/70',
      text: 'text-emerald-800',
      badge: 'bg-emerald-100 text-emerald-800',
      label: 'Halley-Optimized',
    };
  }
  if (score >= 75) {
    return {
      ring: 'border-amber-200 bg-amber-50/70',
      text: 'text-amber-900',
      badge: 'bg-amber-100 text-amber-900',
      label: 'Good — Quick Wins Available',
    };
  }
  return {
    ring: 'border-orange-200 bg-orange-50/70',
    text: 'text-orange-900',
    badge: 'bg-orange-100 text-orange-900',
    label: 'Needs Optimization',
  };
}

export function OptimizeAstroPanel({ onOpenSession, onSpendChanged, autoFocus }: Props) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<AstroAuditReportDto | null>(null);
  const [defaultModelId, setDefaultModelId] = useState('haiku-latest');
  const [escalationModelId, setEscalationModelId] = useState('opus-latest');
  const [aiCeilingUsd, setAiCeilingUsd] = useState(0.5);
  const [error, setError] = useState<string | null>(null);

  const [aiEstimate, setAiEstimate] = useState<OptimizeAiEstimateDto | null>(null);
  const [estimatingAi, setEstimatingAi] = useState(false);
  const [runningAi, setRunningAi] = useState(false);

  const [activePillar, setActivePillar] = useState<'all' | OptimizationPillar>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [useEscalationModel, setUseEscalationModel] = useState(true);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [expandedYamlIds, setExpandedYamlIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocus && containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [autoFocus]);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const latest = await api.adminOptimizeLatest();
        if (cancelled) return;
        setDefaultModelId(latest.defaultModelId);
        setEscalationModelId(latest.escalationModelId);
        setAiCeilingUsd(latest.aiCeilingUsd);
        if (latest.report) {
          setReport(latest.report);
        } else if (autoFocus) {
          setScanning(true);
          const scanned = await api.adminOptimizeScan(false);
          if (!cancelled) {
            setReport(scanned.report);
            setDefaultModelId(scanned.defaultModelId);
            setEscalationModelId(scanned.escalationModelId);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load readiness advisor');
        }
      } finally {
        if (!cancelled) {
          setLoadingInitial(false);
          setScanning(false);
        }
      }
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, [autoFocus]);

  const handleScan = async (force: boolean) => {
    setScanning(true);
    setError(null);
    setAiEstimate(null);
    try {
      const res = await api.adminOptimizeScan(force);
      setReport(res.report);
      setDefaultModelId(res.defaultModelId);
      setEscalationModelId(res.escalationModelId);
      setSelectedIds((prev) => {
        const valid = new Set(
          res.report.findings
            .filter((f) => f.actionKind !== 'workflow_yaml')
            .map((f) => f.id),
        );
        return new Set([...prev].filter((id) => valid.has(id)));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Repository scan failed');
    } finally {
      setScanning(false);
    }
  };

  const handleEstimateAi = async () => {
    if (!report || estimatingAi) return;
    setEstimatingAi(true);
    setError(null);
    try {
      const { estimate } = await api.adminOptimizeAiEstimate(report.sha);
      setAiEstimate(estimate);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not estimate Deep AI Review');
    } finally {
      setEstimatingAi(false);
    }
  };

  const handleRunAiReview = async () => {
    if (!report || runningAi) return;
    setRunningAi(true);
    setError(null);
    try {
      const { report: updated } = await api.adminOptimizeAiReview(report.sha);
      setReport(updated);
      setAiEstimate(null);
      onSpendChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deep AI Review failed');
    } finally {
      setRunningAi(false);
    }
  };

  const selectableFindings = useMemo(
    () => (report?.findings ?? []).filter((f) => f.actionKind !== 'workflow_yaml'),
    [report],
  );

  const deterministicFindings = useMemo(
    () =>
      selectableFindings.filter(
        (f) => f.actionKind === 'deterministic_webp' || f.actionKind === 'deterministic_gitignore',
      ),
    [selectableFindings],
  );

  const selectedFindings = useMemo(
    () => selectableFindings.filter((f) => selectedIds.has(f.id)),
    [selectableFindings, selectedIds],
  );

  const selectedAgentRefactorCount = useMemo(
    () => selectedFindings.filter((f) => f.actionKind === 'agent_refactor').length,
    [selectedFindings],
  );

  const selectedDeterministicCount = useMemo(
    () => selectedFindings.length - selectedAgentRefactorCount,
    [selectedFindings.length, selectedAgentRefactorCount],
  );

  const visibleFindings = useMemo(() => {
    if (!report) return [];
    if (activePillar === 'all') return report.findings;
    return report.findings.filter((f) => f.pillar === activePillar);
  }, [report, activePillar]);

  const toggleFinding = (finding: OptimizationFindingDto) => {
    if (finding.actionKind === 'workflow_yaml') return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(finding.id)) next.delete(finding.id);
      else next.add(finding.id);
      return next;
    });
  };

  const toggleYaml = (id: string) => {
    setExpandedYamlIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopyYaml = async (id: string, yaml: string) => {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((cur) => (cur === id ? null : cur));
      }, 2000);
    } catch (err) {
      reportIgnored(err, 'clipboard write denied');
    }
  };

  const handleCreateDraft = async () => {
    if (!report || selectedIds.size === 0 || creatingDraft) return;
    setCreatingDraft(true);
    setError(null);
    try {
      const { session } = await api.adminCreateOptimizationDraft({
        sha: report.sha,
        findingIds: Array.from(selectedIds),
        useEscalationModel: selectedAgentRefactorCount > 0 ? useEscalationModel : false,
      });
      onOpenSession(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Optimization Draft');
      setCreatingDraft(false);
    }
  };

  const tone = report ? scoreTone(report.score) : null;
  const scoreDelta =
    report?.previousReport != null ? report.score - report.previousReport.score : null;

  return (
    <section
      ref={containerRef}
      data-testid="optimize-astro-panel"
      className="rounded-2xl border border-[#E7E5E4] bg-white p-5 sm:p-6 shadow-xs"
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-900 border border-amber-200/80">
            <Zap className="h-3 w-3 text-amber-600" />
            Optimize Astro
          </div>
          <h2 className="mt-2 text-base sm:text-lg font-semibold text-stone-900">
            Halley Readiness &amp; Publish Speed Advisor
          </h2>
          <p className="mt-1 text-xs sm:text-sm text-stone-500">
            Audits your Astro repository for <strong className="font-medium text-stone-700">$0 inline text editing</strong>,{' '}
            <strong className="font-medium text-stone-700">fast 1-hop AI edits</strong> on lightweight models, and{' '}
            <strong className="font-medium text-stone-700">sub-minute GitHub Pages deploys</strong>.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={scanning || loadingInitial}
            onClick={() => void handleScan(Boolean(report))}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-stone-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-stone-800 disabled:opacity-50"
          >
            {scanning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Scanning…
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                {report ? 'Re-scan live branch' : 'Scan Astro site ($0)'}
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
          {error}
        </div>
      )}

      {loadingInitial ? (
        <div className="mt-6 flex items-center gap-2 text-xs text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading latest audit report…
        </div>
      ) : !report ? (
        <div className="mt-5 rounded-xl border border-dashed border-stone-300 bg-[#FAF9F7] p-5 text-center">
          <p className="text-sm font-medium text-stone-800">
            Run an instant, $0 static AST &amp; asset scan against your live branch
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Takes under 1 second using the local Git mirror — zero tokens spent until you opt into AI review or refactoring.
          </p>
          <button
            type="button"
            disabled={scanning}
            onClick={() => void handleScan(false)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-stone-900 px-4 py-2 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-50"
          >
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-amber-400" />}
            Scan Astro site now
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {/* Score + Inline Editability + Pillar Breakdown */}
          <div className="grid gap-4 lg:grid-cols-12">
            <div
              className={`lg:col-span-4 flex flex-col justify-between rounded-xl border p-4 ${tone?.ring ?? ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
                    Readiness Score
                  </span>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className={`text-4xl font-bold tracking-tight ${tone?.text ?? 'text-stone-900'}`}>
                      {report.score}
                    </span>
                    <span className="text-sm font-medium text-stone-500">/ 100</span>
                  </div>
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${tone?.badge ?? ''}`}>
                  {tone?.label}
                </span>
              </div>

              <div className="mt-3 space-y-1 text-xs text-stone-600">
                {report.previousReport && scoreDelta !== null && (
                  <p className="font-medium text-stone-800">
                    {scoreDelta > 0 ? (
                      <span className="text-emerald-700">
                        ↑ +{scoreDelta} pts since {report.previousReport.shortSha} ({report.previousReport.score} → {report.score})
                      </span>
                    ) : scoreDelta < 0 ? (
                      <span className="text-amber-800">
                        ↓ {scoreDelta} pts since {report.previousReport.shortSha} ({report.previousReport.score} → {report.score})
                      </span>
                    ) : (
                      <span>Unchanged from {report.previousReport.shortSha} ({report.score}/100)</span>
                    )}
                  </p>
                )}
                <p className="text-[11px] text-stone-500">
                  Commit <span className="font-mono">{report.shortSha}</span> on{' '}
                  <span className="font-mono">{report.baseBranch}</span> · {report.metrics.astroPageCount} Astro pages
                </p>
              </div>
            </div>

            <div className="lg:col-span-4 flex flex-col justify-between rounded-xl border border-stone-200 bg-[#FAF9F7] p-4">
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                  $0 Inline-Editable Copy
                </span>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-stone-900">
                    {report.metrics.inlineEditablePct}%
                  </span>
                  <span className="text-xs text-stone-500">
                    ({report.metrics.inlineEditableElements} / {report.metrics.totalTextElements} text blocks)
                  </span>
                </div>
              </div>
              <p className="mt-2 text-xs text-stone-600 leading-relaxed">
                {report.metrics.avoidableLockedElements === 0 ? (
                  <>
                    <strong className="font-medium text-emerald-800">0 avoidable locks.</strong>{' '}
                    {report.metrics.intentionalDynamicElements > 0
                      ? `${report.metrics.intentionalDynamicElements} structured Content Collection / config expressions carry zero score penalty.`
                      : 'All static copy can be edited inline at $0.'}
                  </>
                ) : (
                  <>
                    <strong className="font-medium text-amber-900">
                      {report.metrics.avoidableLockedElements} avoidable locked element
                      {report.metrics.avoidableLockedElements === 1 ? '' : 's'}
                    </strong>{' '}
                    (e.g. static prop text or nested icons).{' '}
                    {report.metrics.intentionalDynamicElements > 0 &&
                      `${report.metrics.intentionalDynamicElements} intentional Content Collection expressions are not penalized.`}
                  </>
                )}
              </p>
            </div>

            <div className="lg:col-span-4 rounded-xl border border-stone-200 bg-[#FAF9F7] p-4 space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                5-Pillar Breakdown
              </span>
              <div className="space-y-1.5 pt-0.5">
                {PILLAR_ORDER.map((pillar) => {
                  const meta = PILLAR_META[pillar];
                  const pct = Math.max(0, Math.min(100, report.pillarScores[pillar] ?? 100));
                  return (
                    <div key={pillar} className="space-y-0.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-medium text-stone-700">{meta.label}</span>
                        <span className="font-mono text-stone-600">{pct}%</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
                        <div
                          className={`h-full rounded-full ${
                            pct === 100 ? 'bg-emerald-600' : pct >= 75 ? 'bg-amber-500' : 'bg-orange-500'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Tier 2: Deep AI Architecture Review */}
          <div className="rounded-xl border border-stone-200 bg-[#FAF9F7] p-4">
            {report.aiReviewedAt ? (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 max-w-3xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-stone-900 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">
                      <Sparkles className="h-3 w-3" />
                      Deep AI Architecture Review
                    </span>
                    <span className="text-[11px] text-stone-500">
                      Completed {new Date(report.aiReviewedAt).toLocaleString()} · ${report.aiCostUsd.toFixed(3)}
                    </span>
                  </div>
                  {report.aiSummary && (
                    <p className="text-xs sm:text-sm text-stone-800 leading-relaxed pt-1">
                      {report.aiSummary}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={estimatingAi || runningAi}
                  onClick={() => void handleEstimateAi()}
                  className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                >
                  Re-run AI review…
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="max-w-2xl">
                  <h3 className="text-xs sm:text-sm font-semibold text-stone-900 flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-amber-600" />
                    Optional: Deep AI Architecture Review ({escalationModelId})
                  </h3>
                  <p className="mt-0.5 text-xs text-stone-500">
                    Spots semantic patterns AST rules can&apos;t see — repeated card blocks ready for a Content Collection, multi-hop data indirection, or missing <code className="font-mono">AGENTS.md</code> conventions. Hard-capped at ${aiCeilingUsd.toFixed(2)}.
                  </p>
                </div>

                {!aiEstimate ? (
                  <button
                    type="button"
                    disabled={estimatingAi}
                    onClick={() => void handleEstimateAi()}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-50 disabled:opacity-50"
                  >
                    {estimatingAi ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Counting tokens…
                      </>
                    ) : (
                      'Estimate cost'
                    )}
                  </button>
                ) : null}
              </div>
            )}

            {aiEstimate && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs">
                <div className="text-stone-800">
                  <strong>{aiEstimate.modelId}</strong> · ~{aiEstimate.inputTokens.toLocaleString()} input tokens · Est.{' '}
                  <strong>${aiEstimate.estimatedUsd.toFixed(3)}</strong> (hard ceiling ${aiEstimate.ceilingUsd.toFixed(2)})
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={runningAi}
                    onClick={() => setAiEstimate(null)}
                    className="rounded-lg px-2.5 py-1 text-xs font-medium text-stone-600 hover:bg-amber-100/60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={runningAi}
                    onClick={() => void handleRunAiReview()}
                    className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-50"
                  >
                    {runningAi ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Reviewing architecture…
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                        Run Deep AI Review (~${aiEstimate.estimatedUsd.toFixed(2)})
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Pillar Filter Bar + Quick Selection */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActivePillar('all')}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                  activePillar === 'all'
                    ? 'bg-stone-900 text-white'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200/70'
                }`}
              >
                All ({report.findings.length})
              </button>
              {PILLAR_ORDER.map((p) => {
                const count = report.findings.filter((f) => f.pillar === p).length;
                if (count === 0) return null;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setActivePillar(p)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      activePillar === p
                        ? 'bg-stone-900 text-white'
                        : 'bg-stone-100 text-stone-600 hover:bg-stone-200/70'
                    }`}
                  >
                    {PILLAR_META[p].label} ({count})
                  </button>
                );
              })}
            </div>

            {selectableFindings.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                {deterministicFindings.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        for (const f of deterministicFindings) next.add(f.id);
                        return next;
                      });
                    }}
                    className="font-medium text-emerald-700 hover:text-emerald-900"
                  >
                    Select $0 quick wins ({deterministicFindings.length})
                  </button>
                )}
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="font-medium text-stone-500 hover:text-stone-800"
                  >
                    Clear ({selectedIds.size})
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Findings List */}
          {visibleFindings.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm text-emerald-900">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <p className="font-semibold">No optimization issues detected!</p>
                <p className="text-xs text-emerald-800">
                  Your Astro templates, assets, guardrails, and GitHub workflows follow Halley&apos;s recommended best practices.
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
              {visibleFindings.map((f) => {
                const isWorkflow = f.actionKind === 'workflow_yaml';
                const isDeterministic =
                  f.actionKind === 'deterministic_webp' ||
                  f.actionKind === 'deterministic_gitignore';
                const checked = selectedIds.has(f.id);
                const yamlOpen = expandedYamlIds.has(f.id);

                return (
                  <div
                    key={f.id}
                    className={`p-4 transition ${
                      checked ? 'bg-amber-50/40' : 'hover:bg-stone-50/60'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {isWorkflow ? (
                        <div
                          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-stone-100 text-stone-500"
                          title="GitHub Workflow — copy YAML & apply on GitHub (keeps Halley least-privilege)"
                        >
                          <FileCode2 className="h-3.5 w-3.5" />
                        </div>
                      ) : (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleFinding(f)}
                          aria-label={`Select ${f.title}`}
                          className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300 text-stone-900 focus:ring-amber-600"
                        />
                      )}

                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                              f.severity === 'high'
                                ? 'bg-amber-100 text-amber-900'
                                : f.severity === 'medium'
                                  ? 'bg-stone-200 text-stone-800'
                                  : 'bg-stone-100 text-stone-600'
                            }`}
                          >
                            {f.severity}
                          </span>
                          <span className="rounded bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600">
                            {PILLAR_META[f.pillar].label}
                          </span>
                          {isDeterministic && (
                            <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                              $0 Instant Pre-Pass
                            </span>
                          )}
                          {f.actionKind === 'agent_refactor' && (
                            <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                              AI Refactor
                            </span>
                          )}
                          {isWorkflow && (
                            <span className="rounded-full bg-stone-100 border border-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-700">
                              GitHub Workflow (Manual Copy)
                            </span>
                          )}
                          {f.source === 'ai' && (
                            <span className="rounded-full bg-stone-900 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                              Deep AI
                            </span>
                          )}
                          <span className="text-[11px] font-medium text-emerald-700">
                            · {f.impactLabel}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h4
                            onClick={() => !isWorkflow && toggleFinding(f)}
                            className={`text-sm font-semibold text-stone-900 ${
                              !isWorkflow ? 'cursor-pointer' : ''
                            }`}
                          >
                            {f.title}
                          </h4>
                          {f.webpCandidate && (
                            <span className="font-mono text-[11px] text-stone-500">
                              {formatBytes(f.webpCandidate.bytes)}
                            </span>
                          )}
                        </div>

                        <p className="text-xs text-stone-600 leading-relaxed">{f.description}</p>

                        {f.files.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {f.files.slice(0, 6).map((file, idx) => (
                              <span
                                key={`${file.path}:${file.line ?? idx}`}
                                title={file.detail || file.path}
                                className="inline-flex items-center gap-1 rounded bg-stone-100 px-2 py-0.5 font-mono text-[11px] text-stone-700"
                              >
                                {file.path}
                                {file.line ? `:${file.line}` : ''}
                              </span>
                            ))}
                            {f.files.length > 6 && (
                              <span className="text-[11px] text-stone-400">
                                +{f.files.length - 6} more
                              </span>
                            )}
                          </div>
                        )}

                        {isWorkflow && f.workflowSuggestion && (
                          <div className="pt-2 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => toggleYaml(f.id)}
                                className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                              >
                                {yamlOpen ? 'Hide Workflow YAML' : 'View Recommended YAML'}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleCopyYaml(f.id, f.workflowSuggestion!.yamlContent)
                                }
                                className="inline-flex items-center gap-1 rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                              >
                                {copiedId === f.id ? (
                                  <>
                                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                                    Copied!
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3.5 w-3.5" />
                                    Copy YAML
                                  </>
                                )}
                              </button>
                              <a
                                href={f.workflowSuggestion.githubEditUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-lg bg-stone-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-stone-800"
                              >
                                Edit on GitHub
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>

                            {yamlOpen && (
                              <pre className="max-h-72 overflow-auto rounded-lg bg-stone-950 p-3 font-mono text-[11px] text-stone-100 leading-relaxed">
                                {f.workflowSuggestion.yamlContent}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Friendly batch size tip */}
          {selectedAgentRefactorCount > 5 && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs text-amber-950">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <strong>Batching tip:</strong> You have {selectedAgentRefactorCount} AI structural refactors selected. Grouping <strong>3–5 AI refactors</strong> per Optimization Draft keeps diffs easy to visually verify before publishing ($0 image &amp; <code className="font-mono">.gitignore</code> fixes don&apos;t add review complexity).
              </div>
            </div>
          )}

          {/* Create Optimization Draft Action Bar */}
          {selectedIds.size > 0 && (
            <div className="flex flex-col gap-3 rounded-xl border border-stone-900/15 bg-[#FAF9F7] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1.5">
                <p className="text-xs sm:text-sm font-semibold text-stone-900">
                  Ready to create Optimization Draft ({selectedIds.size} selected)
                </p>
                {selectedAgentRefactorCount > 0 ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-stone-600">Refactor model:</span>
                    <button
                      type="button"
                      onClick={() => setUseEscalationModel(true)}
                      className={`rounded-lg border px-2.5 py-1 font-medium transition ${
                        useEscalationModel
                          ? 'border-stone-900 bg-stone-900 text-white'
                          : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
                      }`}
                    >
                      {escalationModelId} (Recommended · steps back to {defaultModelId} after)
                    </button>
                    <button
                      type="button"
                      onClick={() => setUseEscalationModel(false)}
                      className={`rounded-lg border px-2.5 py-1 font-medium transition ${
                        !useEscalationModel
                          ? 'border-stone-900 bg-stone-900 text-white'
                          : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
                      }`}
                    >
                      {defaultModelId} (Standard)
                    </button>
                  </div>
                ) : (
                  <p className="text-xs font-medium text-emerald-800">
                    $0 Deterministic Pre-Pass Only ({selectedDeterministicCount} item
                    {selectedDeterministicCount === 1 ? '' : 's'}) — converts assets &amp; updates references instantly with zero AI spend, then opens Live vs Draft review.
                  </p>
                )}
              </div>

              <button
                type="button"
                disabled={creatingDraft}
                onClick={() => void handleCreateDraft()}
                className="inline-flex min-h-[42px] shrink-0 items-center justify-center gap-2 rounded-xl bg-stone-900 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white transition hover:bg-stone-800 disabled:opacity-50"
              >
                {creatingDraft ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Preparing draft…
                  </>
                ) : (
                  <>
                    <Wand2 className="h-4 w-4 text-amber-400" />
                    Create Optimization Draft ({selectedIds.size})
                    <ArrowUpRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
