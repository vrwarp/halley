import type { Context } from 'hono';
import { ignore } from './log.js';

/**
 * Reads a JSON request body as a plain object for handlers whose fields are all optional or are
 * validated afterwards (a schema rejects `{}` with a 400).
 * - empty body -> `{}` (expected: many clients POST without a body)
 * - malformed JSON or a non-object JSON value -> `{}`, logged at debug (client error, high volume)
 * - stream errors (oversized body via bodyLimit, client abort) propagate to the error handler so a
 *   413 is not silently turned into an empty request.
 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    ignore(err, 'request body is not valid JSON; treating as empty', { method: c.req.method, path: c.req.path }, 'debug');
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') {
    ignore(null, 'request body is not a JSON object; treating as empty', {
      method: c.req.method,
      path: c.req.path,
      type: parsed === null ? 'null' : typeof parsed,
    }, 'debug');
    return {};
  }
  return parsed as Record<string, unknown>;
}
