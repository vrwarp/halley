import crypto from 'node:crypto';
import type { SpendPurpose } from '@halley/shared';
import type { Context } from 'hono';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb } from '../db.js';

// Per-million-token pricing (USD) for Anthropic models, aligned with @earendil-works/pi-ai
export const MODEL_RATES: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-haiku-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5-20251101': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // Legacy Opus 4 / 4.1 pricing
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4-20250514': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
};

export function getModelRate(model: string) {
  return (
    MODEL_RATES[model] ??
    (model.includes('opus')
      ? MODEL_RATES['claude-opus-5-5']!
      : model.includes('haiku')
        ? MODEL_RATES['claude-haiku-5-5']!
        : MODEL_RATES['claude-sonnet-5-5']!)
  );
}

export function computeCostUsd(
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
): number {
  const rate = getModelRate(model);
  const inp = (usage.input_tokens ?? 0) / 1_000_000;
  const out = (usage.output_tokens ?? 0) / 1_000_000;
  const cw = (usage.cache_creation_input_tokens ?? 0) / 1_000_000;
  const cr = (usage.cache_read_input_tokens ?? 0) / 1_000_000;
  return inp * rate.input + out * rate.output + cw * rate.cacheWrite + cr * rate.cacheRead;
}

function modelFamily(modelId: string): 'haiku' | 'sonnet' | 'opus' | null {
  const lower = modelId.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('opus')) return 'opus';
  return null;
}

/**
 * Family-based allowlist (F15): prevents workspaces or prompt-injected agents from
 * requesting arbitrary expensive models. Escalation models (e.g. opus-latest) are only
 * permitted when `purpose === 'conflict-escalation'`.
 */
export function isModelAllowedForPurpose(
  requestedModel: string,
  purpose: SpendPurpose,
  config: Pick<HalleyConfig, 'modelId' | 'conflictModelId' | 'escalationModelId'>,
): boolean {
  const allowedBaseIds = new Set([config.modelId, config.conflictModelId]);
  if (allowedBaseIds.has(requestedModel)) return true;

  const reqFamily = modelFamily(requestedModel);
  const baseFamilies = new Set(
    [config.modelId, config.conflictModelId].map(modelFamily).filter(Boolean),
  );
  if (reqFamily && baseFamilies.has(reqFamily)) return true;

  if (purpose === 'conflict-escalation') {
    if (requestedModel === config.escalationModelId) return true;
    const escFamily = modelFamily(config.escalationModelId);
    if (reqFamily && escFamily && reqFamily === escFamily) return true;
  }

  return false;
}

export function hashWorkspaceToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

const VALID_PURPOSES = new Set<SpendPurpose>([
  'chat',
  'conflict',
  'conflict-escalation',
  'handoff',
]);

// Tracks in-flight spend per escalation runId so streaming responses can abort at the ceiling (F16)
const activeRunSpendUsd = new Map<string, { spent: number; updatedAt: number }>();

function pruneStaleRuns() {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [k, v] of activeRunSpendUsd.entries()) {
    if (v.updatedAt < cutoff) activeRunSpendUsd.delete(k);
  }
}

export function createLlmProxyHandler(
  config: HalleyConfig,
  db: ControlPlaneDb,
  onSpendUpdated?: (userId: string, sessionId: string) => void,
): (c: Context) => Promise<Response> {
  return async (c: Context): Promise<Response> => {
    const authHeader = c.req.header('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const xApiKey = c.req.header('x-api-key') || '';
    const rawToken = bearer || xApiKey;

    if (!rawToken) {
      return c.json({ error: { message: 'Missing workspace token' } }, 401);
    }

    const session = db.getSessionByTokenHash(hashWorkspaceToken(rawToken));
    if (!session) {
      return c.json({ error: { message: 'Invalid workspace token' } }, 401);
    }

    if (!config.anthropicApiKey) {
      return c.json({ error: { message: 'Server ANTHROPIC_API_KEY is not configured' } }, 500);
    }

    const subPath = c.req.path.replace(/^\/internal\/llm\/anthropic/, '') || '/v1/messages';
    const isCountTokens = subPath.includes('/count_tokens');

    const rawPurpose = (c.req.header('x-halley-purpose') || 'chat') as SpendPurpose;
    const purpose: SpendPurpose = VALID_PURPOSES.has(rawPurpose) ? rawPurpose : 'chat';

    const bodyText = await c.req.text();
    let requestedModel = config.modelId;
    const headModelMatch = bodyText.slice(0, 4096).match(/"model"\s*:\s*"([^"]+)"/);
    if (headModelMatch?.[1]) {
      requestedModel = headModelMatch[1];
    } else if (bodyText.length > 4096) {
      const tailModelMatch = bodyText.slice(-4096).match(/"model"\s*:\s*"([^"]+)"/);
      if (tailModelMatch?.[1]) requestedModel = tailModelMatch[1];
    }

    // F15: Enforce model allowlist (count_tokens is allowed for escalation model estimation)
    const allowCheckPurpose: SpendPurpose = isCountTokens ? 'conflict-escalation' : purpose;
    if (!isModelAllowedForPurpose(requestedModel, allowCheckPurpose, config)) {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'permission_error',
            message: `Model "${requestedModel}" is not allowed for purpose "${purpose}".`,
          },
        },
        403,
      );
    }

    // Free token counting endpoint: forward directly without charging spend
    const upstreamUrl = `${config.anthropicBaseUrl}${subPath}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': c.req.header('anthropic-version') || '2023-06-01',
    };
    const beta = c.req.header('anthropic-beta');
    if (beta) headers['anthropic-beta'] = beta;

    if (isCountTokens) {
      const upstream = await fetch(upstreamUrl, {
        method: c.req.method,
        headers,
        body: bodyText || undefined,
      });
      const txt = await upstream.text();
      return new Response(txt, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      });
    }

    const spend = db.getSpendStatus(session.owner_user_id);
    if (spend.capped) {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `Daily AI editing budget ($${(spend.dailyCapUsd + spend.extraGrantedUsd).toFixed(2)}) reached for today. Ask an admin to grant extra allowance.`,
          },
        },
        429,
      );
    }

    // F16: Per-run hard ceiling check (used by escalation runs, capped at config.escalationMaxUsd)
    pruneStaleRuns();
    const runId = c.req.header('x-halley-run-id') || '';
    const requestedCeiling = Number(c.req.header('x-halley-run-ceiling-usd') || '0');
    const runCeilingUsd =
      runId && Number.isFinite(requestedCeiling) && requestedCeiling > 0
        ? Math.min(requestedCeiling, config.escalationMaxUsd)
        : purpose === 'conflict-escalation'
          ? config.escalationMaxUsd
          : 0;
    const effectiveRunKey = runId ? `${session.id}:${runId}` : '';
    const priorRunSpent = effectiveRunKey ? activeRunSpendUsd.get(effectiveRunKey)?.spent ?? 0 : 0;

    if (runCeilingUsd > 0 && priorRunSpent >= runCeilingUsd) {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'run_ceiling_reached',
            message: `Stopped at $${priorRunSpent.toFixed(2)} to stay within the $${runCeilingUsd.toFixed(2)} estimate ceiling.`,
          },
        },
        429,
      );
    }

    const abortController = new AbortController();
    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: bodyText || undefined,
      signal: abortController.signal,
    });

    const recordRunCost = (cost: number) => {
      if (!effectiveRunKey || cost <= 0) return priorRunSpent;
      const cur = activeRunSpendUsd.get(effectiveRunKey)?.spent ?? 0;
      const next = cur + cost;
      activeRunSpendUsd.set(effectiveRunKey, { spent: next, updatedAt: Date.now() });
      return next;
    };

    const contentType = upstream.headers.get('content-type') || 'application/json';
    if (!contentType.includes('text/event-stream') || !upstream.body) {
      const txt = await upstream.text();
      try {
        const json = JSON.parse(txt) as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
        if (json.usage) {
          const cost = computeCostUsd(requestedModel, json.usage);
          recordRunCost(cost);
          db.recordSpend(
            session.owner_user_id,
            cost,
            (json.usage.input_tokens ?? 0) +
              (json.usage.cache_creation_input_tokens ?? 0) +
              (json.usage.cache_read_input_tokens ?? 0),
            json.usage.output_tokens ?? 0,
            undefined,
            { sessionId: session.id, purpose, model: requestedModel },
          );
          onSpendUpdated?.(session.owner_user_id, session.id);
        }
      } catch {
        // ignore
      }
      return new Response(txt, {
        status: upstream.status,
        headers: { 'Content-Type': contentType },
      });
    }

    // Stream SSE while tapping usage events and enforcing in-flight per-run ceiling
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWrite = 0;
    let cacheRead = 0;
    let lineBuf = '';
    const decoder = new TextDecoder();

    const reader = upstream.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          const cost = computeCostUsd(requestedModel, {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheWrite,
            cache_read_input_tokens: cacheRead,
          });
          if (cost > 0 || inputTokens > 0 || outputTokens > 0) {
            recordRunCost(cost);
            db.recordSpend(
              session.owner_user_id,
              cost,
              inputTokens + cacheWrite + cacheRead,
              outputTokens,
              undefined,
              { sessionId: session.id, purpose, model: requestedModel },
            );
            onSpendUpdated?.(session.owner_user_id, session.id);
          }
          controller.close();
          return;
        }
        controller.enqueue(value);
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload) as {
              type?: string;
              message?: {
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_creation_input_tokens?: number;
                  cache_read_input_tokens?: number;
                };
              };
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
              };
            };
            if (evt.type === 'message_start' && evt.message?.usage) {
              inputTokens = evt.message.usage.input_tokens ?? inputTokens;
              outputTokens = evt.message.usage.output_tokens ?? outputTokens;
              cacheWrite = evt.message.usage.cache_creation_input_tokens ?? cacheWrite;
              cacheRead = evt.message.usage.cache_read_input_tokens ?? cacheRead;
            } else if (evt.type === 'message_delta' && evt.usage) {
              if (typeof evt.usage.output_tokens === 'number') {
                outputTokens = evt.usage.output_tokens;
              }
            }

            // In-flight ceiling guard: abort stream if run exceeds its ceiling
            if (runCeilingUsd > 0) {
              const currentCost = computeCostUsd(requestedModel, {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheWrite,
                cache_read_input_tokens: cacheRead,
              });
              if (priorRunSpent + currentCost > runCeilingUsd) {
                recordRunCost(currentCost);
                db.recordSpend(
                  session.owner_user_id,
                  currentCost,
                  inputTokens + cacheWrite + cacheRead,
                  outputTokens,
                  undefined,
                  { sessionId: session.id, purpose, model: requestedModel },
                );
                onSpendUpdated?.(session.owner_user_id, session.id);
                abortController.abort();
                reader.cancel().catch(() => {});
                controller.close();
                return;
              }
            }
          } catch {
            // ignore partial JSON
          }
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    });

    return new Response(stream, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  };
}
