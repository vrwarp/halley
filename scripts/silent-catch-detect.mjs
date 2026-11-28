// Detection heuristics for scripts/check-no-silent-catch.mjs (kept separate so they can be
// unit-tested: scripts/silent-catch-detect.test.mjs).
//
// Categories:
//   emptyCatch          `catch {}` / `catch (e) {}` whose body is only whitespace/comments
//   emptyCatchCallback  `.catch(() => {})` / `.catch((e) => {})` / `.catch(e => {})` (empty body)
//   catchToDefault      `.catch(() => <literal>)` with null/false/true/undefined/[]/({})/0/''/""
//   catchReturnSilently `catch {...}` whose body is only `return ...;` (plus comments) and does
//                       not log, report or rethrow
// Regex heuristics, not a parser: they are meant to ratchet a count down, not to be exact.

const EMPTY_BODY = String.raw`(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*`;
const CALLBACK_PARAMS = String.raw`(?:\(\s*[\w$]*\s*(?::[^)]*)?\)|[\w$]+)`;
const DEFAULT_LITERAL = String.raw`(?:null|false|true|undefined|\[\s*\]|\(\s*\{\s*\}\s*\)|0|''|""|\`\`)`;
/** A body mentioning any of these is treated as handled (logged, reported, rethrown, surfaced). */
export const LOGGY = /ignore|logger|console\.|report|warn|throw|setError|toast|notice|setNotice|log\(/;

export const CATEGORIES = ['emptyCatch', 'emptyCatchCallback', 'catchToDefault', 'catchReturnSilently'];

const PATTERNS = [
  { kind: 'emptyCatch', re: new RegExp(String.raw`\bcatch\s*(?:\([^)]*\))?\s*\{${EMPTY_BODY}\}`, 'g') },
  {
    kind: 'emptyCatchCallback',
    re: new RegExp(String.raw`\.catch\(\s*${CALLBACK_PARAMS}\s*=>\s*\{${EMPTY_BODY}\}\s*\)`, 'g'),
  },
  {
    kind: 'catchToDefault',
    re: new RegExp(String.raw`\.catch\(\s*${CALLBACK_PARAMS}\s*=>\s*${DEFAULT_LITERAL}\s*\)`, 'g'),
  },
  {
    kind: 'catchReturnSilently',
    re: /\bcatch\s*(?:\([^)]*\))?\s*\{([^{}]{0,200})\}/g,
    accept: (m) => /^\s*(?:\/\/[^\n]*\s*)*return\b[^;]*;\s*$/.test(m[1]) && !LOGGY.test(m[1]),
  },
];

/**
 * Finds silent catches in one source text.
 * @param {string} text
 * @returns {{ counts: Record<string, number>, hits: Array<{ kind: string, index: number, line: number, snippet: string }> }}
 */
export function detectSilentCatches(text) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const hits = [];
  for (const { kind, re, accept } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (accept && !accept(m)) continue;
      counts[kind]++;
      hits.push({
        kind,
        index: m.index,
        line: text.slice(0, m.index).split('\n').length,
        snippet: m[0].replace(/\s+/g, ' ').slice(0, 70),
      });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return { counts, hits };
}
