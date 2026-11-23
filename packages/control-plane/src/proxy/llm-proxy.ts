import crypto from 'node:crypto';
import type { Context } from 'hono';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb } from '../db.js';

// Per-million-token pricing (USD) for Anthropic models
const MODEL_RATES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-4-5': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-haiku-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

function computeCostUsd(
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
): number {
  const rate =
    MODEL_RATES[model] ??
    (model.includes('opus')
      ? MODEL_RATES['claude-opus-4-5']!
      : model.includes('haiku')
        ? MODEL_RATES['claude-haiku-4-5']!
        : MODEL_RATES['claude-sonnet-4-5']!);

  const inp = (usage.input_tokens ?? 0) / 1_000_000;
  const out = (usage.output_tokens ?? 0) / 1_000_000;
  const cw = (usage.cache_creation_input_tokens ?? 0) / 1_000_000;
  const cr = (usage.cache_read_input_tokens ?? 0) / 1_000_000;
  return inp * rate.input + out * rate.output + cw * rate.cacheWrite + cr * rate.cacheRead;
}

export function hashWorkspaceToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
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

    const subPath = c.req.path.replace(/^\/internal\/llm\/anthropic/, '') || '/v1/messages';
    const upstreamUrl = `${config.anthropicBaseUrl}${subPath}`;
    const bodyText = await c.req.text();
    let requestedModel = config.modelId;
    try {
      const parsed = JSON.parse(bodyText) as { model?: string };
      if (parsed.model) requestedModel = parsed.model;
    } catch {
      // ignore
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': c.req.header('anthropic-version') || '2023-06-01',
    };
    const beta = c.req.header('anthropic-beta');
    if (beta) headers['anthropic-beta'] = beta;

    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: bodyText || undefined,
    });

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
          db.recordSpend(
            session.owner_user_id,
            cost,
            (json.usage.input_tokens ?? 0) + (json.usage.cache_creation_input_tokens ?? 0) + (json.usage.cache_read_input_tokens ?? 0),
            json.usage.output_tokens ?? 0,
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

    // Stream SSE while tapping usage events
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
            db.recordSpend(
              session.owner_user_id,
              cost,
              inputTokens + cacheWrite + cacheRead,
              outputTokens,
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
              inputTokens += evt.message.usage.input_tokens ?? 0;
              outputTokens += evt.message.usage.output_tokens ?? 0;
              cacheWrite += evt.message.usage.cache_creation_input_tokens ?? 0;
              cacheRead += evt.message.usage.cache_read_input_tokens ?? 0;
            } else if (evt.type === 'message_delta' && evt.usage) {
              outputTokens += evt.usage.output_tokens ?? 0;
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
