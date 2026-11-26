import crypto from 'node:crypto';
import type {
  AstroAuditReportDto,
  EditorSessionDto,
  OptimizationFindingDto,
  OptimizationPillar,
  OptimizeAiEstimateDto,
  UserDto,
} from '@halley/shared';
import { slugifyRouteSegment } from '@halley/shared';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import type { WorkspaceDriver } from '../drivers/workspace-driver.js';
import { computeCostUsd, getModelRate, hashWorkspaceToken } from '../proxy/llm-proxy.js';

export const DEEP_AI_CEILING_USD = 0.5;

const PILLAR_SET = new Set<OptimizationPillar>([
  'inline_edit',
  'agent_context',
  'source_mapping',
  'guardrails',
  'speed_and_ci',
]);

function recomputeScoreWithAiFindings(findings: OptimizationFindingDto[]): number {
  const caps: Record<OptimizationPillar, number> = {
    inline_edit: 25,
    agent_context: 25,
    source_mapping: 15,
    guardrails: 20,
    speed_and_ci: 25,
  };
  const deductions: Record<OptimizationPillar, number> = {
    inline_edit: 0,
    agent_context: 0,
    source_mapping: 0,
    guardrails: 0,
    speed_and_ci: 0,
  };
  for (const f of findings) {
    deductions[f.pillar] = Math.min(caps[f.pillar], deductions[f.pillar] + Math.max(0, f.scorePenalty));
  }
  const total = Object.values(deductions).reduce((s, n) => s + n, 0);
  return Math.max(0, Math.min(100, Math.round(100 - total)));
}

function buildDeepAiPrompts(digest: string): { system: string; user: string } {
  const system = [
    'You are an expert Astro 5 & Halley Web Editor architecture reviewer.',
    'Halley provides two ways for church/team maintainers to edit Astro websites:',
    '1. $0 Inline Editing (`contenteditable`): works only on static HTML elements whose children are plain text + `{strong, b, em, i, br, span, a}`.',
    '2. Conversational AI Agent (default: Haiku-class model with a 64K–80K active context cliff): excels at 1–2 hop edits, modular Content Collections, concise `<500` line files, and explicit `AGENTS.md` + Zod schemas.',
    '',
    'Inspect the repository digest and identify 0 to 5 HIGH-VALUE semantic optimization opportunities that static regex/AST rules could NOT catch (for example: copy-pasted multi-section card blocks that belong in a Content Collection, contradictory or missing rules in AGENTS.md vs actual code, deep multi-hop data indirection that confuses Haiku, or subtle layout/SEO maintainability traps).',
    'Do NOT repeat findings already listed under "Already Detected Static Findings", and do NOT suggest `.github/workflows` edits.',
    '',
    'Respond ONLY with valid JSON matching this exact shape (no markdown fences):',
    '{"summary":"1-2 sentence executive takeaway","findings":[{"pillar":"inline_edit|agent_context|source_mapping|guardrails|speed_and_ci","severity":"high|medium|low","title":"Short actionable title","description":"Clear explanation of why this hurts inline editing or Haiku reliability","impactLabel":"Short badge e.g. Cuts 3-file edits to 1 file","files":[{"path":"src/...","line":1,"detail":"optional"}],"scorePenalty":3,"agentInstructions":"Precise, pixel-safe refactoring instructions for an engineer agent"}]}',
  ].join('\n');

  return {
    system,
    user: digest,
  };
}

export class OptimizeService {
  private cachedResolvedModels = new Map<string, string>();

  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private driver: WorkspaceDriver,
    private enrichSessionDto: (row: SessionRecord, viewer: UserDto) => EditorSessionDto,
    private onSessionMetaUpdated?: (sessionId: string) => void,
    private onSpendUpdated?: (userId: string) => void,
  ) {}

  async resolveConcreteAnthropicModel(aliasOrId: string): Promise<string> {
    const cached = this.cachedResolvedModels.get(aliasOrId);
    if (cached) return cached;

    const family =
      aliasOrId === 'opus-latest'
        ? 'opus'
        : aliasOrId === 'sonnet-latest'
          ? 'sonnet'
          : aliasOrId === 'haiku-latest'
            ? 'haiku'
            : null;
    if (!family) return aliasOrId;

    const fallback =
      family === 'opus'
        ? 'claude-opus-4-6'
        : family === 'sonnet'
          ? 'claude-sonnet-4-6'
          : 'claude-haiku-4-5';

    if (!this.config.anthropicApiKey) {
      return fallback;
    }

    try {
      const res = await fetch(`${this.config.anthropicBaseUrl}/v1/models`, {
        headers: {
          'x-api-key': this.config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ id: string }> };
        const ids = (json.data ?? []).map((m) => m.id).filter((id) => id.includes(family));
        if (ids.length > 0) {
          const parseVer = (id: string) => {
            const clean = id.replace(/-\d{8}$/, '');
            const nums = clean.match(/\d+/g)?.map(Number) ?? [0];
            return [...nums, clean === id ? 1 : 0];
          };
          ids.sort((a, b) => {
            const va = parseVer(a);
            const vb = parseVer(b);
            const len = Math.max(va.length, vb.length);
            for (let i = 0; i < len; i++) {
              const d = (vb[i] ?? 0) - (va[i] ?? 0);
              if (d !== 0) return d;
            }
            return 0;
          });
          const picked = ids[0]!;
          this.cachedResolvedModels.set(aliasOrId, picked);
          return picked;
        }
      }
    } catch {
      // fall back cleanly
    }

    return fallback;
  }

  getLatestOverview(): {
    report: AstroAuditReportDto | null;
    defaultModelId: string;
    escalationModelId: string;
    aiCeilingUsd: number;
  } {
    const latest = this.db.getLatestAuditReport(this.config.baseBranch);
    return {
      report: latest?.report ?? null,
      defaultModelId: this.config.modelId,
      escalationModelId: this.config.escalationModelId,
      aiCeilingUsd: DEEP_AI_CEILING_USD,
    };
  }

  async runStaticScan(opts?: { force?: boolean }): Promise<AstroAuditReportDto> {
    if (!this.driver.scanRepository) {
      throw new Error('Current workspace driver does not support repository optimization scanning');
    }
    const scanned = await this.driver.scanRepository(this.config.baseBranch);
    if (!opts?.force) {
      const existing = this.db.getAuditReport(scanned.sha);
      if (existing) {
        return existing.report;
      }
    }
    return this.db.upsertStaticAuditReport({
      sha: scanned.sha,
      baseBranch: this.config.baseBranch,
      report: scanned.report,
      digest: scanned.digest,
    });
  }

  async estimateDeepAiReview(sha: string, user: UserDto): Promise<OptimizeAiEstimateDto> {
    const entry = this.db.getAuditReport(sha);
    if (!entry) {
      throw new Error('Scan report not found — run a static scan first.');
    }

    const modelId = await this.resolveConcreteAnthropicModel(this.config.escalationModelId);
    const { system, user: userPrompt } = buildDeepAiPrompts(entry.digest);

    let inputTokens = Math.ceil((system.length + userPrompt.length) / 3.8);
    if (this.config.anthropicApiKey) {
      try {
        const ctRes = await fetch(`${this.config.anthropicBaseUrl}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.anthropicApiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: modelId,
            system,
            messages: [{ role: 'user', content: userPrompt }],
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (ctRes.ok) {
          const ctJson = (await ctRes.json()) as { input_tokens?: number };
          if (typeof ctJson.input_tokens === 'number' && ctJson.input_tokens > 0) {
            inputTokens = ctJson.input_tokens;
          }
        }
      } catch {
        // use character heuristic fallback
      }
    }

    const expectedOutputTokens = 1800;
    const rawEst = computeCostUsd(modelId, {
      input_tokens: inputTokens,
      output_tokens: expectedOutputTokens,
    });
    const estimatedUsd = Number(Math.min(DEEP_AI_CEILING_USD, Math.max(0.005, rawEst)).toFixed(3));

    const spend = this.db.getSpendStatus(user.id);
    const remainingBudgetUsd = Number(
      Math.max(0, spend.dailyCapUsd + spend.extraGrantedUsd - spend.spentTodayUsd).toFixed(3),
    );

    return {
      sha,
      modelId,
      inputTokens,
      estimatedUsd,
      ceilingUsd: DEEP_AI_CEILING_USD,
      remainingBudgetUsd,
      alreadyReviewed: Boolean(entry.report.aiReviewedAt),
    };
  }

  async runDeepAiReview(sha: string, user: UserDto): Promise<AstroAuditReportDto> {
    const entry = this.db.getAuditReport(sha);
    if (!entry) {
      throw new Error('Scan report not found — run a static scan first.');
    }
    if (!this.config.anthropicApiKey) {
      throw new Error('Server ANTHROPIC_API_KEY is not configured');
    }

    const spend = this.db.getSpendStatus(user.id);
    if (spend.capped) {
      throw new Error('Daily AI spend cap reached — grant extra budget above to run Deep AI Review.');
    }

    const modelId = await this.resolveConcreteAnthropicModel(this.config.escalationModelId);
    const { system, user: userPrompt } = buildDeepAiPrompts(entry.digest);

    const rate = getModelRate(modelId);
    const approxInputTokens = Math.ceil((system.length + userPrompt.length) / 3.6);
    const approxInputUsd = (approxInputTokens / 1_000_000) * rate.input;
    const remainingCeilingUsd = DEEP_AI_CEILING_USD - approxInputUsd;
    if (remainingCeilingUsd < 0.02) {
      throw new Error(
        `Repository digest exceeds the $${DEEP_AI_CEILING_USD.toFixed(2)} Deep AI Review ceiling.`,
      );
    }

    const maxOutputByCeiling = Math.floor((remainingCeilingUsd / rate.output) * 1_000_000);
    const maxTokens = Math.max(512, Math.min(3000, maxOutputByCeiling));

    const res = await fetch(`${this.config.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => res.statusText);
      throw new Error(`Anthropic Deep AI Review failed (${res.status}): ${errBody.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    const usage = data.usage ?? {};
    const costUsd = Math.min(DEEP_AI_CEILING_USD, computeCostUsd(modelId, usage));
    this.db.recordSpend(
      user.id,
      costUsd,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      undefined,
      { purpose: 'optimize', model: modelId },
    );
    this.onSpendUpdated?.(user.id);

    const rawText = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('')
      .trim();

    let summary = 'Completed deep architecture review.';
    const aiFindings: OptimizationFindingDto[] = [];

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as {
          summary?: string;
          findings?: Array<{
            pillar?: string;
            severity?: string;
            title?: string;
            description?: string;
            impactLabel?: string;
            files?: Array<{ path?: string; line?: number; detail?: string }>;
            scorePenalty?: number;
            agentInstructions?: string;
          }>;
        };
        if (parsed.summary?.trim()) {
          summary = parsed.summary.trim();
        }
        for (const item of (parsed.findings ?? []).slice(0, 5)) {
          if (!item.title?.trim() || !item.description?.trim()) continue;
          const pillar: OptimizationPillar = PILLAR_SET.has(item.pillar as OptimizationPillar)
            ? (item.pillar as OptimizationPillar)
            : 'agent_context';
          const severity =
            item.severity === 'high' || item.severity === 'medium' || item.severity === 'low'
              ? item.severity
              : 'medium';
          const files = (item.files ?? [])
            .filter((f): f is { path: string; line?: number; detail?: string } => Boolean(f?.path))
            .filter((f) => !f.path.startsWith('.github/'))
            .slice(0, 6);
          const id = crypto
            .createHash('sha1')
            .update(`ai:${sha}:${item.title}`, 'utf8')
            .digest('hex')
            .slice(0, 12);
          aiFindings.push({
            id,
            pillar,
            severity,
            actionKind: 'agent_refactor',
            source: 'ai',
            title: item.title.trim(),
            description: item.description.trim(),
            impactLabel: item.impactLabel?.trim() || 'AI architecture improvement',
            files,
            scorePenalty: Math.max(1, Math.min(6, Number(item.scorePenalty) || 3)),
            agentInstructions: item.agentInstructions?.trim() || item.description.trim(),
          });
        }
      } catch {
        // keep default empty findings if model returned malformed JSON
      }
    }

    const staticFindings = entry.report.findings.filter((f) => f.source !== 'ai');
    const updatedScore = recomputeScoreWithAiFindings([...staticFindings, ...aiFindings]);

    const updated = this.db.saveAiAuditReview({
      sha,
      summary,
      findings: aiFindings,
      costUsd,
      updatedScore,
    });
    if (!updated) {
      throw new Error('Failed to persist Deep AI Review');
    }
    return updated;
  }

  async createOptimizationDraft(
    user: UserDto,
    input: {
      sha: string;
      findingIds: string[];
      useEscalationModel?: boolean;
      title?: string;
    },
  ): Promise<EditorSessionDto> {
    const entry = this.db.getAuditReport(input.sha);
    if (!entry) {
      throw new Error('Scan report not found — run a static scan first.');
    }

    const wantedIds = new Set(input.findingIds ?? []);
    const selected = entry.report.findings.filter(
      (f) => wantedIds.has(f.id) && f.actionKind !== 'workflow_yaml',
    );
    if (selected.length === 0) {
      throw new Error('Select at least one site or asset optimization to create a draft.');
    }

    const hasAgentRefactors = selected.some((f) => f.actionKind === 'agent_refactor');
    const useEscalation = Boolean(input.useEscalationModel ?? true) && hasAgentRefactors;

    let sessionId: string = crypto.randomUUID();
    let volumeName = `halley-ws-${sessionId}`;
    let rawToken = crypto.randomBytes(24).toString('hex');

    if (this.driver.reserveWarmWorkspace) {
      const warm = await this.driver.reserveWarmWorkspace();
      if (warm) {
        sessionId = warm.id;
        volumeName = warm.volumeName;
        rawToken = warm.rawToken;
      }
    }

    const title =
      input.title?.trim() ||
      (selected.length === 1
        ? `Optimize: ${selected[0]!.title.slice(0, 60)}`
        : `Optimize Astro (${selected.length} improvements)`);
    const slug = slugifyRouteSegment(title) || 'optimize-astro';
    const short = sessionId.slice(0, 6);

    const session = this.db.createSession({
      id: sessionId,
      title,
      slug,
      kind: 'edit',
      ownerUserId: user.id,
      repo: this.config.repo,
      baseBranch: this.config.baseBranch,
      workingBranch: `halley/${slug}-${short}`,
      volumeName,
      workspaceTokenHash: hashWorkspaceToken(rawToken),
    });

    if (useEscalation) {
      this.db.updateSession(session.id, {
        optimize_escalation_allowed: 1,
        active_model_label: this.config.escalationModelId,
      });
    } else if (hasAgentRefactors) {
      this.db.updateSession(session.id, {
        active_model_label: this.config.modelId,
      });
    }

    this.driver.setRawWorkspaceToken?.(session.id, rawToken);

    const freshSession = this.db.getSession(session.id)!;
    const targetModelId = useEscalation ? this.config.escalationModelId : this.config.modelId;
    const targetThinking = useEscalation
      ? this.config.escalationThinkingLevel
      : this.config.thinkingLevel;

    // Boot workspace & trigger pre-pass + initial optimization turn in background
    void (async () => {
      try {
        const ep = await this.driver.ensureRunning(freshSession);
        const res = await fetch(`${ep.runnerUrl}/internal/optimize/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            findings: selected,
            modelId: targetModelId,
            defaultModelId: this.config.modelId,
            thinkingLevel: targetThinking,
          }),
        });
        if (!res.ok) {
          this.db.updateSession(session.id, {
            optimize_escalation_allowed: 0,
            active_model_label: null,
          });
          this.onSessionMetaUpdated?.(session.id);
        }
      } catch (err) {
        this.db.updateSession(session.id, {
          status: 'error',
          publish_error: err instanceof Error ? err.message : 'Failed to start optimization draft',
          optimize_escalation_allowed: 0,
          active_model_label: null,
        });
        this.onSessionMetaUpdated?.(session.id);
      }
    })();

    return this.enrichSessionDto(this.db.getSession(session.id)!, user);
  }
}
