// Run: node --test scripts/*.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectSilentCatches } from './silent-catch-detect.mjs';

const count = (src) => detectSilentCatches(src).counts;
const only = (src, kind, n = 1) => {
  const c = count(src);
  for (const [k, v] of Object.entries(c)) assert.equal(v, k === kind ? n : 0, `${k} for: ${src}`);
};
const none = (src) => {
  for (const [k, v] of Object.entries(count(src))) assert.equal(v, 0, `${k} for: ${src}`);
};

describe('emptyCatch', () => {
  it('counts empty and comment-only catch blocks', () => {
    only('try { a(); } catch {}', 'emptyCatch');
    only('try { a(); } catch (e) {\n  // nothing\n}', 'emptyCatch');
    only('try { a(); } catch (err) { /* ok */ }', 'emptyCatch');
  });
  it('ignores non-empty blocks', () => {
    none('try { a(); } catch (err) { console.warn(err); }');
  });
});

describe('emptyCatchCallback', () => {
  it('counts .catch with an empty arrow body', () => {
    only('p.catch(() => {})', 'emptyCatchCallback');
    only('p.catch((e) => { })', 'emptyCatchCallback');
    only('p.catch(e => {})', 'emptyCatchCallback');
    only('p.catch((e: unknown) => { /* drop */ })', 'emptyCatchCallback');
  });
});

describe('catchToDefault', () => {
  it('counts .catch returning a literal default', () => {
    for (const lit of ['null', 'false', 'true', 'undefined', '[]', '({})', '0', "''", '""']) {
      only(`await p.catch(() => ${lit});`, 'catchToDefault');
    }
    only('p.catch((err) => null)', 'catchToDefault');
    only('p.catch(err => false)', 'catchToDefault');
  });
  it('ignores handled or non-literal fallbacks', () => {
    none('p.catch((err) => { console.warn(err); return null; })');
    none('p.catch((err) => fallback(err))');
    none('p.catch(() => 10)');
    none("p.catch(() => 'x')");
  });
});

describe('catchReturnSilently', () => {
  it('counts catch blocks that only return', () => {
    only('try { x = JSON.parse(s); } catch { return null; }', 'catchReturnSilently');
    only('try { a(); } catch (e) {\n  return;\n}', 'catchReturnSilently');
    only('try { a(); } catch {\n  // fallback\n  return [];\n}', 'catchReturnSilently');
  });
  it('ignores blocks that log, report, rethrow or do more than return', () => {
    none('try { a(); } catch (err) { console.warn(err); return null; }');
    none("try { a(); } catch (err) { reportIgnored(err, 'x'); return null; }");
    none("try { a(); } catch (err) { ignoreMissingPath('x', err); return; }");
    none('try { a(); } catch (err) { if (err instanceof SyntaxError) return undefined; throw err; }');
    none('try { a(); } catch { failed = true; return null; }');
    none('try { a(); } catch { return { ok: false }; }');
  });
});

describe('hits', () => {
  it('reports line numbers and kinds in source order', () => {
    const { hits } = detectSilentCatches('a();\np.catch(() => null);\ntry { b(); } catch {}\n');
    assert.deepEqual(
      hits.map((h) => [h.line, h.kind]),
      [
        [2, 'catchToDefault'],
        [3, 'emptyCatch'],
      ],
    );
  });
});
