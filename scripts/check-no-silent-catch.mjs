#!/usr/bin/env node
// Ratchet check: counts silent error swallowing in packages/*/src (tests excluded) and fails if
// any package's count rises above scripts/silent-catch-baseline.json.
//
//   node scripts/check-no-silent-catch.mjs            # compare against baseline
//   node scripts/check-no-silent-catch.mjs --update   # rewrite the baseline with current counts
//   node scripts/check-no-silent-catch.mjs --verbose  # also list every occurrence
//
// Counted per package and per category (see scripts/silent-catch-detect.mjs):
//   emptyCatch, emptyCatchCallback, catchToDefault, catchReturnSilently
// The check fails when any category of any package rises above its baseline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, detectSilentCatches } from './silent-catch-detect.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'scripts', 'silent-catch-baseline.json');
const args = new Set(process.argv.slice(2));
const update = args.has('--update');
const verbose = args.has('--verbose');

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const isTestFile = (rel) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)(__tests__|__mocks__|test|tests)\//.test(rel);

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(abs);
    else if (SOURCE_EXT.has(path.extname(ent.name)) && !ent.name.endsWith('.d.ts')) yield abs;
  }
}

const counts = {};
const hits = [];
const pkgsDir = path.join(root, 'packages');
for (const pkg of fs.readdirSync(pkgsDir).sort()) {
  const srcDir = path.join(pkgsDir, pkg, 'src');
  if (!fs.existsSync(srcDir)) continue;
  counts[pkg] = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const abs of walk(srcDir)) {
    const rel = path.relative(srcDir, abs).split(path.sep).join('/');
    if (isTestFile(rel)) continue;
    const found = detectSilentCatches(fs.readFileSync(abs, 'utf8'));
    for (const c of CATEGORIES) counts[pkg][c] += found.counts[c];
    for (const h of found.hits) hits.push(`${path.relative(root, abs)}:${h.line}  ${h.kind}  ${h.snippet}`);
  }
}

if (verbose) for (const h of hits) console.log(h);

if (update) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, baselinePath)}:`, counts);
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
} catch (err) {
  console.error(`Cannot read baseline ${baselinePath}: ${err.message}. Run with --update to create it.`);
  process.exit(2);
}

/** Accepts the per-category format and the older `{ pkg: total }` one (total -> every category). */
const baselineOf = (pkg, category) => {
  const b = baseline[pkg];
  if (typeof b === 'number') return b;
  return b?.[category] ?? 0;
};

let failed = false;
const short = { emptyCatch: 'empty', emptyCatchCallback: 'emptyCb', catchToDefault: 'toDefault', catchReturnSilently: 'returnSilent' };
console.log('package'.padEnd(18), CATEGORIES.map((c) => `${short[c]} (cur/base)`.padStart(25)).join(''));
for (const [pkg, byCat] of Object.entries(counts)) {
  const cells = [];
  const notes = [];
  for (const c of CATEGORIES) {
    const n = byCat[c];
    const base = baselineOf(pkg, c);
    if (n > base) {
      failed = true;
      notes.push(`${c} increased`);
    } else if (n < base) notes.push(`${c} below baseline`);
    cells.push(`${n}/${base}`.padStart(25));
  }
  console.log(pkg.padEnd(18), cells.join(''), notes.length ? `  <-- ${notes.join(', ')}` : '');
}
if (failed) {
  console.error(
    '\nSilent catch count increased. Handle or log the error instead of swallowing it ' +
      '(run with --verbose to list occurrences).',
  );
  process.exit(1);
}
console.log('\nOK: no package exceeds its silent-catch baseline (run --update to ratchet down).');
