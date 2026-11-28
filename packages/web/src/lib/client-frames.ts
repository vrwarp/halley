import type { ChatServerMessage, TranscriptEntryDto } from '@halley/shared';

/**
 * Reuse previous entry objects (and the previous array) when a `transcript_state` frame
 * carries unchanged entries, so memoized transcript rows skip re-rendering while only
 * the streaming text changes.
 */
const entrySignatures = new WeakMap<TranscriptEntryDto, string>();
function entrySignature(e: TranscriptEntryDto): string {
  let sig = entrySignatures.get(e);
  if (sig === undefined) {
    sig = JSON.stringify(e);
    entrySignatures.set(e, sig);
  }
  return sig;
}
export function shareTranscriptEntries(
  prev: TranscriptEntryDto[],
  next: TranscriptEntryDto[],
): TranscriptEntryDto[] {
  if (prev === next) return prev;
  const prevById = new Map<string, TranscriptEntryDto>();
  for (const e of prev) prevById.set(e.id, e);
  let allSame = prev.length === next.length;
  const out = next.map((e, i) => {
    const old = prevById.get(e.id);
    if (old && entrySignature(old) === entrySignature(e)) {
      if (prev[i] !== old) allSame = false;
      return old;
    }
    allSame = false;
    return e;
  });
  return allSame ? prev : out;
}

/** Minimal shape check for server WebSocket frames: a JSON object with a string `type`. */
export function parseServerFrame(data: unknown): ChatServerMessage | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    console.warn('[halley] dropping malformed WebSocket frame', err);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
  return parsed as ChatServerMessage;
}

/** Notice text for a server `error` frame (falls back when the message is missing/empty). */
export function errorFrameText(msg: { message?: unknown }): string {
  return typeof msg.message === 'string' && msg.message ? msg.message : 'Server error';
}
