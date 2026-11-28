import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAstroSource } from '@halley/astro-dev-edit';
import { analyzeCiCoverage, parseHalleyCheckCommands } from '@halley/shared';
import type {
  AstroAuditMetricsDto,
  AstroAuditReportDto,
  CheckpointInfo,
  OptimizationFindingDto,
  OptimizationPillar,
} from '@halley/shared';
import sharp from 'sharp';
import { createCheckpoint, type GitIdentity } from './checkpoints-and-git.js';
import { readdirEntriesOrEmpty, readFileOr, writeFileAtomic } from './fs-util.js';
import { ignore, ignoreExpected, isMissingPathError } from './log.js';
import { execFileGroup, getProcessRunner, killProcessGroup } from './proc.js';
import { realClock, type Clock } from './clock.js';

// git runs through the injectable ProcessRunner (own process group)
const execFileAsync = execFileGroup;

const ALLOWED_INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'br', 'span', 'a']);
const TEXT_ELEMENT_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'blockquote',
  'figcaption',
]);
const TEXT_PROP_NAMES = new Set([
  'title',
  'subtitle',
  'heading',
  'subheading',
  'eyebrow',
  'description',
  'lead',
  'summary',
  'tagline',
]);

const RASTER_IMAGE_RE = /\.(png|jpe?g)$/i;
const OVERSIZED_IMAGE_THRESHOLD_BYTES = 300 * 1024;
const MONOLITHIC_DATA_THRESHOLD_BYTES = 16 * 1024;
const MEGA_ASTRO_LINES_THRESHOLD = 500;
const INLINE_SVG_THRESHOLD_BYTES = 2500;

interface AstPosition {
  start: { line: number; column: number; offset: number };
  end?: { line: number; column: number; offset: number };
}

interface AstAttribute {
  type: 'attribute';
  name: string;
  kind: 'quoted' | 'empty' | 'expression' | 'spread' | 'shorthand' | 'template-literal';
  value: string;
  position?: AstPosition;
}

interface AstNode {
  type: string;
  name?: string;
  value?: string;
  attributes?: AstAttribute[];
  children?: AstNode[];
  position?: AstPosition;
}

interface TreeEntry {
  mode: string;
  type: string;
  blobSha: string;
  size: number;
  path: string;
}

function findingId(rule: string, primaryPath: string): string {
  return crypto
    .createHash('sha1')
    .update(`${rule}:${primaryPath}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function shouldReadTextBlob(filePath: string, size: number): boolean {
  if (size > 512 * 1024) return false;
  if (
    filePath === 'AGENTS.md' ||
    filePath === 'package.json' ||
    filePath === '.gitignore' ||
    filePath === '.halley.json' ||
    /^astro\.config\.(mjs|ts|js)$/.test(filePath)
  ) {
    return true;
  }
  if (filePath.startsWith('.github/workflows/') && /\.ya?ml$/i.test(filePath)) {
    return true;
  }
  if (filePath.startsWith('public/') && /(?:manifest|webmanifest).*\.json$/i.test(filePath)) {
    return true;
  }
  if (filePath.startsWith('src/')) {
    return /\.(astro|ts|tsx|js|jsx|mjs|json|md|mdx|css)$/i.test(filePath);
  }
  return false;
}

/** Deadline and output ceiling for one `git cat-file --batch` audit read. */
const BLOB_BATCH_TIMEOUT_MS = 60_000;
const BLOB_BATCH_MAX_BYTES = 256 * 1024 * 1024;

async function readBlobsBatch(
  gitDir: string,
  entries: TreeEntry[],
  clock: Clock = realClock,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (entries.length === 0) return result;

  return new Promise((resolve, reject) => {
    const child = getProcessRunner().spawn('git', ['-c', 'safe.directory=*', 'cat-file', '--batch'], {
      cwd: gitDir,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    const fail = (err: Error) => {
      if (failure) return;
      failure = err;
      killProcessGroup(child, 'SIGKILL');
    };
    const timer = clock.setTimeout(
      () => fail(new Error(`git cat-file --batch timed out after ${BLOB_BATCH_TIMEOUT_MS}ms`)),
      BLOB_BATCH_TIMEOUT_MS,
    );
    timer.unref?.();
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > BLOB_BATCH_MAX_BYTES) {
        fail(new Error(`git cat-file --batch output exceeded ${BLOB_BATCH_MAX_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    // a killed reader closes stdin under us: EPIPE is expected then
    child.stdin!.on('error', (err) => ignoreExpected(err, 'optimizer: cat-file stdin closed'));
    child.on('error', (err) => {
      clock.clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clock.clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      const buf = Buffer.concat(chunks);
      let offset = 0;
      for (const entry of entries) {
        const nl = buf.indexOf(0x0a, offset);
        if (nl === -1) break;
        const header = buf.subarray(offset, nl).toString('utf8');
        offset = nl + 1;
        if (header.endsWith(' missing')) continue;
        const parts = header.trim().split(/\s+/);
        const size = Number(parts[2] ?? 0);
        if (!Number.isFinite(size) || size < 0 || offset + size > buf.length) break;
        const content = buf.subarray(offset, offset + size).toString('utf8');
        result.set(entry.path, content);
        offset += size + 1; // trailing LF after blob payload
      }
      resolve(result);
    });

    const input = `${entries.map((e) => e.blobSha).join('\n')}\n`;
    child.stdin!.write(input);
    child.stdin!.end();
  });
}

function isUrlHelperExpr(attr: AstAttribute): boolean {
  if (attr.kind !== 'expression') return false;
  return /^url\(\s*['"`][^'"`]+['"`]\s*\)$/.test((attr.value ?? '').trim());
}

function isWhitespaceExpr(node: AstNode): boolean {
  if (node.type !== 'expression') return false;
  const children = node.children ?? [];
  if (children.length === 0) return true;
  return children.every(
    (c) => c.type === 'text' && /^['"`]\s*['"`]$/.test((c.value ?? '').trim()),
  );
}

function checkInlineStatic(nodes: AstNode[]): {
  isStatic: boolean;
  hasNestedSvgOrIcon: boolean;
  hasPlainSiblingText: boolean;
  expressionText: string;
} {
  let isStatic = true;
  let hasNestedSvgOrIcon = false;
  let hasPlainSiblingText = false;
  const exprParts: string[] = [];

  for (const child of nodes) {
    if (child.type === 'text') {
      if ((child.value ?? '').trim().length > 0) {
        hasPlainSiblingText = true;
      }
      continue;
    }
    if (child.type === 'comment') continue;
    if (child.type === 'expression') {
      if (isWhitespaceExpr(child)) continue;
      isStatic = false;
      const rawExpr = (child.children ?? [])
        .map((c) => c.value ?? '')
        .join('')
        .trim();
      if (rawExpr) exprParts.push(rawExpr);
      continue;
    }
    if ((child.type === 'element' || child.type === 'component') && child.name) {
      const lower = child.name.toLowerCase();
      if (lower === 'svg' || /icon$/i.test(child.name)) {
        hasNestedSvgOrIcon = true;
        isStatic = false;
        continue;
      }
      if (child.type === 'component' || !ALLOWED_INLINE_TAGS.has(lower)) {
        isStatic = false;
        continue;
      }
      for (const attr of child.attributes ?? []) {
        if (attr.kind === 'spread' || attr.kind === 'shorthand') {
          isStatic = false;
        } else if (attr.kind === 'expression' && !(lower === 'a' && attr.name === 'href' && isUrlHelperExpr(attr))) {
          isStatic = false;
        }
      }
      const sub = checkInlineStatic(child.children ?? []);
      if (!sub.isStatic) isStatic = false;
      if (sub.hasPlainSiblingText) hasPlainSiblingText = true;
      if (sub.hasNestedSvgOrIcon) hasNestedSvgOrIcon = true;
      if (sub.expressionText) exprParts.push(sub.expressionText);
      continue;
    }
    isStatic = false;
  }

  return {
    isStatic,
    hasNestedSvgOrIcon,
    hasPlainSiblingText,
    expressionText: exprParts.join(' '),
  };
}

function extractFrontmatter(source: string): { frontmatter: string; bodyStartLine: number } {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { frontmatter: '', bodyStartLine: 1 };
  const lines = m[0].split(/\r?\n/).length;
  return { frontmatter: m[1] ?? '', bodyStartLine: lines };
}

function detectAstroBaseFromTexts(texts: Map<string, string>): string {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) {
    const content = texts.get(name);
    if (!content) continue;
    const m = content.match(/\bbase\s*:\s*['"]([^'"]+)['"]/);
    if (m?.[1]) {
      const b = m[1].startsWith('/') ? m[1] : `/${m[1]}`;
      return b === '/' ? '/' : b.replace(/\/$/, '');
    }
  }
  return '/';
}

function buildRecommendedDeployYaml(opts: {
  baseBranch: string;
  usePnpm: boolean;
  hasVerifySeo: boolean;
}): string {
  const installStep = opts.usePnpm
    ? `      - name: Install pnpm\n        uses: pnpm/action-setup@v4\n\n      - name: Setup Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: pnpm\n\n      - name: Configure Pages\n        uses: actions/configure-pages@v5\n\n      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n\n      - name: Build static site\n        run: pnpm run build`
    : `      - name: Setup Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n\n      - name: Configure Pages\n        uses: actions/configure-pages@v5\n\n      - name: Install dependencies\n        run: npm ci\n\n      - name: Build static site\n        run: npm run build`;

  const seoStep = opts.hasVerifySeo
    ? `\n\n      - name: Verify SEO, sitemap & structured data\n        run: ${opts.usePnpm ? 'pnpm' : 'npm'} run verify:seo`
    : '';

  return `name: Deploy to GitHub Pages

on:
  push:
    branches: [ ${opts.baseBranch} ]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

${installStep}${seoStep}

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist

      - name: Wait for artifact metadata consistency
        run: sleep 3

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

export function computeAuditScore(findings: OptimizationFindingDto[]): {
  score: number;
  pillarScores: Record<OptimizationPillar, number>;
} {
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

  const totalDeduction = Object.values(deductions).reduce((sum, n) => sum + n, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - totalDeduction)));

  const pillarScores: Record<OptimizationPillar, number> = {
    inline_edit: Math.max(0, Math.round(100 - (deductions.inline_edit / caps.inline_edit) * 100)),
    agent_context: Math.max(0, Math.round(100 - (deductions.agent_context / caps.agent_context) * 100)),
    source_mapping: Math.max(0, Math.round(100 - (deductions.source_mapping / caps.source_mapping) * 100)),
    guardrails: Math.max(0, Math.round(100 - (deductions.guardrails / caps.guardrails) * 100)),
    speed_and_ci: Math.max(0, Math.round(100 - (deductions.speed_and_ci / caps.speed_and_ci) * 100)),
  };

  return { score, pillarScores };
}

export async function scanBareGitRepo(
  gitDir: string,
  opts: { repoSlug: string; baseBranch: string; ref?: string },
): Promise<{ sha: string; report: AstroAuditReportDto; digest: string }> {
  const ref = opts.ref || `refs/heads/${opts.baseBranch}`;
  const { stdout: shaOut } = await execFileAsync(
    'git',
    ['-c', 'safe.directory=*', 'rev-parse', ref],
    { cwd: gitDir },
  );
  const sha = shaOut.trim();

  const { stdout: lsOut } = await execFileAsync(
    'git',
    ['-c', 'safe.directory=*', 'ls-tree', '-r', '-l', sha],
    { cwd: gitDir, maxBuffer: 32 * 1024 * 1024 },
  );

  const treeEntries: TreeEntry[] = [];
  for (const line of lsOut.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = line.slice(0, tabIdx).trim().split(/\s+/);
    const filePath = line.slice(tabIdx + 1).trim();
    if (meta.length < 4 || meta[1] !== 'blob') continue;
    treeEntries.push({
      mode: meta[0]!,
      type: meta[1]!,
      blobSha: meta[2]!,
      size: Number(meta[3]) || 0,
      path: filePath,
    });
  }

  const textTargets = treeEntries.filter((e) => shouldReadTextBlob(e.path, e.size));
  const texts = await readBlobsBatch(gitDir, textTargets);

  const findings: OptimizationFindingDto[] = [];
  const astroBase = detectAstroBaseFromTexts(texts);
  const hasPnpmLock = treeEntries.some((e) => e.path === 'pnpm-lock.yaml');

  // Index framework component files (.tsx/.jsx/.vue/.svelte) for extensionless/named import resolution
  const frameworkFileSet = new Set(
    treeEntries
      .map((e) => e.path)
      .filter((p) => p.startsWith('src/') && /\.(?:tsx|jsx|vue|svelte)$/i.test(p)),
  );

  // Inspect components that render props vs <slot />
  const componentHasSlot = new Map<string, boolean>();
  const componentRendersProps = new Map<string, Set<string>>();
  for (const [filePath, source] of texts.entries()) {
    if (!filePath.startsWith('src/components/') || !filePath.endsWith('.astro')) continue;
    const baseName = path.basename(filePath, '.astro');
    componentHasSlot.set(baseName, /<slot\b/i.test(source));
    const propHits = new Set<string>();
    for (const p of TEXT_PROP_NAMES) {
      if (new RegExp(`\\b${p}\\b`).test(source)) propHits.add(p);
    }
    componentRendersProps.set(baseName, propHits);
  }

  // Collect dynamic image directory prefixes & manifest/default OG exclusions
  const excludedImagePaths = new Set<string>();
  const dynamicImageDirs = new Set<string>();

  for (const [filePath, content] of texts.entries()) {
    if (filePath.startsWith('public/') && filePath.endsWith('json')) {
      for (const m of content.matchAll(/["'](\/?[^"']+\.(?:png|jpe?g|ico))["']/gi)) {
        const clean = m[1]!.replace(/^\/+/, '');
        excludedImagePaths.add(clean);
      }
    }
    if (!filePath.startsWith('src/')) continue;

    // Detect default og:image fallback paths in layouts or site config
    if (/Layout\.astro$|site\.ts$/i.test(filePath)) {
      for (const m of content.matchAll(/['"](\/images\/[^'"]+\.(?:png|jpe?g|webp))['"]/gi)) {
        if (/og|social|share|card|default/i.test(m[1]!)) {
          excludedImagePaths.add(m[1]!.replace(/^\/+/, ''));
        }
      }
    }

    // Detect template literal dynamic paths like `/images/staff/${person.slug}.png`
    for (const m of content.matchAll(/`([^`]*\$\{[^`]+\}[^`]*\.(?:png|jpe?g))`/gi)) {
      const prefix = m[1]!.split('${')[0] ?? '';
      const cleanDir = prefix
        .replace(/^.*\/images\//, 'images/')
        .replace(/^\/+/, '')
        .replace(/\/[^/]*$/, '');
      if (cleanDir) dynamicImageDirs.add(cleanDir);
    }
  }

  let totalTextElements = 0;
  let inlineEditableElements = 0;
  let intentionalDynamicElements = 0;
  let avoidableLockedElements = 0;
  let astroPageCount = 0;

  const propLockedByComponent = new Map<
    string,
    { componentFile: string; usages: Array<{ path: string; line: number; prop: string }> }
  >();
  const nestedSvgHits: Array<{ path: string; line: number; detail: string }> = [];
  const staticArrayMapHits: Array<{ path: string; line: number; detail: string }> = [];
  const inlineSvgBlobs: Array<{ path: string; line: number; bytes: number }> = [];
  const staticJsxComponents = new Map<string, Array<{ path: string; line: number }>>();

  // Parse all .astro files
  const astroEntries = [...texts.entries()].filter(([p]) => p.startsWith('src/') && p.endsWith('.astro'));
  for (const [filePath, source] of astroEntries) {
    if (filePath.startsWith('src/pages/')) astroPageCount += 1;

    const totalLines = source.split(/\r?\n/).length;
    if (totalLines > MEGA_ASTRO_LINES_THRESHOLD) {
      findings.push({
        id: findingId('mega-astro-file', filePath),
        pillar: 'agent_context',
        severity: totalLines > 800 ? 'high' : 'medium',
        actionKind: 'agent_refactor',
        source: 'static',
        title: `Split large ${totalLines}-line Astro template (${path.basename(filePath)})`,
        description:
          'Files over 500 lines consume a large share of Haiku’s 64K–80K active context window and increase exact-match edit retries.',
        impactLabel: `Shrinks ${totalLines} lines into focused sub-components`,
        files: [{ path: filePath, line: 1, detail: `${totalLines} lines` }],
        scorePenalty: totalLines > 800 ? 6 : 4,
        agentInstructions: `Extract self-contained visual sections from \`${filePath}\` (${totalLines} lines) into clean \`.astro\` components under \`src/components/\` using \`<slot />\` for static copy where appropriate, keeping rendered HTML and styling 100% pixel-identical.`,
      });
    }

    const { frontmatter } = extractFrontmatter(source);

    // Check small static string arrays in frontmatter rendered via .map()
    for (const arrMatch of frontmatter.matchAll(
      /const\s+([A-Za-z0-9_]+)\s*=\s*\[\s*((?:['"][^'"]{15,}['"]\s*,?\s*){2,6})\]/g,
    )) {
      const varName = arrMatch[1]!;
      if (new RegExp(`\\b${varName}\\.map\\s*\\(`).test(source)) {
        const line = source.slice(0, arrMatch.index ?? 0).split(/\r?\n/).length;
        staticArrayMapHits.push({
          path: filePath,
          line,
          detail: `Static array \`${varName}\` rendered via .map()`,
        });
      }
    }

    // Check JSX/Vue/Svelte components imported in frontmatter (default, named, or extensionless)
    const jsxImports = new Map<string, string>();
    const fileDir = path.posix.dirname(filePath);
    for (const imp of frontmatter.matchAll(
      /import\s+(?!type\b)([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g,
    )) {
      const clause = imp[1]!.trim();
      const spec = imp[2]!.trim();
      let isFrameworkModule = /\.(?:tsx|jsx|vue|svelte)$/i.test(spec);
      if (!isFrameworkModule && spec.startsWith('.')) {
        const resolvedBase = path.posix.normalize(path.posix.join(fileDir, spec));
        for (const ext of ['.tsx', '.jsx', '.vue', '.svelte']) {
          if (frameworkFileSet.has(`${resolvedBase}${ext}`)) {
            isFrameworkModule = true;
            break;
          }
        }
      }
      if (!isFrameworkModule) continue;

      // Default import (e.g. `import Card from '...'` or `import Card, { Sub } from '...'`)
      const defaultPart = clause.split('{')[0]?.replace(/,\s*$/, '').trim();
      if (defaultPart && /^[A-Z][A-Za-z0-9_]*$/.test(defaultPart)) {
        jsxImports.set(defaultPart, spec);
      }

      // Named imports (e.g. `import { StaticReactCard, Foo as Bar } from '...'`)
      const namedMatch = clause.match(/\{([^}]+)\}/);
      if (namedMatch) {
        for (const rawItem of namedMatch[1]!.split(',')) {
          const item = rawItem.replace(/^\s*type\s+/, '').trim();
          if (!item) continue;
          const parts = item.split(/\s+as\s+/);
          const localName = (parts[1] ?? parts[0] ?? '').trim();
          if (/^[A-Z][A-Za-z0-9_]*$/.test(localName)) {
            jsxImports.set(localName, spec);
          }
        }
      }
    }

    // Check large inline <svg> blocks in source
    for (const svgMatch of source.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
      const svgBytes = Buffer.byteLength(svgMatch[0], 'utf8');
      if (svgBytes >= INLINE_SVG_THRESHOLD_BYTES) {
        const line = source.slice(0, svgMatch.index ?? 0).split(/\r?\n/).length;
        inlineSvgBlobs.push({ path: filePath, line, bytes: svgBytes });
      }
    }

    let parsedRoot: AstNode | null = null;
    try {
      const parsed = await parseAstroSource(source, { position: true });
      parsedRoot = parsed.ast as unknown as AstNode;
    } catch (err) {
      // unparsable .astro (mid-edit or broken): skipped here; `astro check` reports it
      ignoreExpected(err, 'optimizer: parse astro source');
      parsedRoot = null;
    }
    if (!parsedRoot) continue;

    const walkAst = (node: AstNode) => {
      if ((node.type === 'element' || node.type === 'component') && node.name) {
        const tag = node.name.toLowerCase();

        // Check static text/heading elements
        if (node.type === 'element' && TEXT_ELEMENT_TAGS.has(tag)) {
          const children = node.children ?? [];
          if (children.length > 0) {
            totalTextElements += 1;
            const check = checkInlineStatic(children);
            if (check.isStatic) {
              inlineEditableElements += 1;
            } else if (check.hasNestedSvgOrIcon && check.hasPlainSiblingText) {
              avoidableLockedElements += 1;
              nestedSvgHits.push({
                path: filePath,
                line: node.position?.start.line ?? 1,
                detail: `<${tag}> mixes an inline icon/SVG directly with text`,
              });
            } else {
              intentionalDynamicElements += 1;
            }
          }
        }

        // Check prop-passed static string literals on .astro components without <slot />
        if (node.type === 'component') {
          const compName = node.name;
          if (jsxImports.has(compName)) {
            const hasClientDirective = (node.attributes ?? []).some((a) =>
              a.name.startsWith('client:'),
            );
            if (!hasClientDirective) {
              const list = staticJsxComponents.get(compName) ?? [];
              list.push({ path: filePath, line: node.position?.start.line ?? 1 });
              staticJsxComponents.set(compName, list);
            }
          }

          const hasSlot = componentHasSlot.get(compName);
          const renderedProps = componentRendersProps.get(compName);
          if (hasSlot === false && renderedProps && renderedProps.size > 0) {
            for (const attr of node.attributes ?? []) {
              if (
                attr.kind === 'quoted' &&
                TEXT_PROP_NAMES.has(attr.name) &&
                renderedProps.has(attr.name) &&
                attr.value.trim().length >= 4
              ) {
                avoidableLockedElements += 1;
                const compPath = `src/components/${compName}.astro`;
                const entry = propLockedByComponent.get(compName) ?? {
                  componentFile: compPath,
                  usages: [],
                };
                entry.usages.push({
                  path: filePath,
                  line: attr.position?.start.line ?? node.position?.start.line ?? 1,
                  prop: attr.name,
                });
                propLockedByComponent.set(compName, entry);
              }
            }
          }
        }
      }

      for (const child of node.children ?? []) {
        walkAst(child);
      }
    };

    walkAst(parsedRoot);
  }

  // Emit Pillar 1 findings (Inline-Edit Coverage)
  for (const [compName, info] of propLockedByComponent.entries()) {
    if (info.usages.length < 2) continue;
    findings.push({
      id: findingId('prop-text-component', info.componentFile),
      pillar: 'inline_edit',
      severity: info.usages.length >= 6 ? 'medium' : 'low',
      actionKind: 'agent_refactor',
      source: 'static',
      title: `Unlock inline editing in <${compName}> via <slot />`,
      description: `\`<${compName}>\` renders static text props (${[...new Set(info.usages.map((u) => u.prop))].join(', ')}) with no \`<slot />\`, forcing an AI chat turn instead of $0 click-to-edit.`,
      impactLabel: `Unlocks $0 inline editing across ${info.usages.length} headings/blocks`,
      files: [
        { path: info.componentFile, line: 1, detail: 'Component definition' },
        ...info.usages.slice(0, 5).map((u) => ({
          path: u.path,
          line: u.line,
          detail: `Static \`${u.prop}="..."\` prop`,
        })),
      ],
      scorePenalty: Math.min(8, 3 + Math.floor(info.usages.length / 3)),
      agentInstructions: `Refactor \`${info.componentFile}\` so primary static text can be passed via \`<slot />\` (while keeping backward compatibility if an optional prop is still passed), and update static string-literal call sites (${info.usages.slice(0, 8).map((u) => `${u.path}:${u.line}`).join(', ')}) to pass static children so Halley's inline editor unlocks them. Preserve exact HTML tags, classes, and visual layout.`,
    });
  }

  if (nestedSvgHits.length > 0) {
    findings.push({
      id: findingId('nested-svg-in-text', nestedSvgHits[0]!.path),
      pillar: 'inline_edit',
      severity: 'low',
      actionKind: 'agent_refactor',
      source: 'static',
      title: `Wrap text beside inline icons in <span> (${nestedSvgHits.length} element${nestedSvgHits.length === 1 ? '' : 's'})`,
      description:
        'Headings or paragraphs containing an inline `<svg>` directly beside raw text are marked dynamic by the AST classifier. Wrapping the text in a `<span>` makes the copy click-to-editable for $0.',
      impactLabel: `Unlocks $0 inline editing on ${nestedSvgHits.length} icon+text element${nestedSvgHits.length === 1 ? '' : 's'}`,
      files: nestedSvgHits.slice(0, 6),
      scorePenalty: Math.min(6, nestedSvgHits.length * 2),
      agentInstructions: `In ${nestedSvgHits.slice(0, 8).map((h) => `\`${h.path}:${h.line}\``).join(', ')}, wrap the plain text sibling next to the inline \`<svg>\`/icon inside a \`<span>...</span>\` without changing flex/alignment or visual appearance so Halley's AST classifier marks the \`<span>\` as inline-editable.`,
    });
  }

  if (staticArrayMapHits.length > 0) {
    findings.push({
      id: findingId('static-prose-array', staticArrayMapHits[0]!.path),
      pillar: 'inline_edit',
      severity: 'low',
      actionKind: 'agent_refactor',
      source: 'static',
      title: `Unroll small frontmatter prose arrays (${staticArrayMapHits.length} file${staticArrayMapHits.length === 1 ? '' : 's'})`,
      description:
        'Small 2–6 item static string arrays in frontmatter rendered via `.map()` prevent inline `contenteditable` editing without saving meaningful code.',
      impactLabel: `Unlocks direct inline text editing in ${staticArrayMapHits.length} page${staticArrayMapHits.length === 1 ? '' : 's'}`,
      files: staticArrayMapHits.slice(0, 6),
      scorePenalty: Math.min(6, staticArrayMapHits.length * 2),
      agentInstructions: `In ${staticArrayMapHits.map((h) => `\`${h.path}:${h.line}\``).join(', ')}, replace the small static frontmatter prose array \`.map()\` with static Astro HTML markup (or a lightweight local component with \`<slot />\`) so editors can click and edit the copy inline, keeping identical rendered HTML and classes.`,
    });
  }

  // Emit Pillar 2 findings (Haiku Context-Cliff Hazards)
  for (const entry of treeEntries) {
    if (
      entry.path.startsWith('src/') &&
      !entry.path.startsWith('src/content/') &&
      /\.(json|ts)$/i.test(entry.path) &&
      entry.size >= MONOLITHIC_DATA_THRESHOLD_BYTES
    ) {
      findings.push({
        id: findingId('monolithic-data', entry.path),
        pillar: 'agent_context',
        severity: entry.size >= 40 * 1024 ? 'high' : 'medium',
        actionKind: 'agent_refactor',
        source: 'static',
        title: `Split monolithic data file \`${entry.path}\` (${formatBytes(entry.size)})`,
        description:
          'Large single-file datasets consume thousands of tokens on every `read` tool call, pushing Haiku toward its 64K compaction cliff.',
        impactLabel: `Avoids reading ${formatBytes(entry.size)} per edit turn`,
        files: [{ path: entry.path, detail: formatBytes(entry.size) }],
        scorePenalty: entry.size >= 40 * 1024 ? 10 : 6,
        agentInstructions: `Refactor \`${entry.path}\` (${formatBytes(entry.size)}) into a per-item Astro Content Collection under \`src/content/\` with a Zod schema in \`src/content.config.ts\` (or modular per-topic files), updating all imports so rendered pages remain 100% identical.`,
      });
    }
  }

  if (inlineSvgBlobs.length > 0) {
    const totalSvgBytes = inlineSvgBlobs.reduce((s, b) => s + b.bytes, 0);
    findings.push({
      id: findingId('inline-svg-blobs', inlineSvgBlobs[0]!.path),
      pillar: 'agent_context',
      severity: totalSvgBytes > 12 * 1024 ? 'medium' : 'low',
      actionKind: 'agent_refactor',
      source: 'static',
      title: `Extract ${inlineSvgBlobs.length} large inline <svg> asset${inlineSvgBlobs.length === 1 ? '' : 's'} (${formatBytes(totalSvgBytes)})`,
      description:
        'Multi-kilobyte raw `<svg>` path data inline inside `.astro` files bloats agent file reads and slows exact-string edits.',
      impactLabel: `Saves ${formatBytes(totalSvgBytes)} of raw SVG path tokens in templates`,
      files: inlineSvgBlobs.slice(0, 6).map((s) => ({
        path: s.path,
        line: s.line,
        detail: formatBytes(s.bytes),
      })),
      scorePenalty: Math.min(8, 3 + inlineSvgBlobs.length),
      agentInstructions: `Extract the large inline \`<svg>\` graphics at ${inlineSvgBlobs.map((s) => `\`${s.path}:${s.line}\``).join(', ')} into dedicated \`.svg\` files under \`public/images/\` (or dedicated icon components if \`currentColor\` styling requires inline SVG), preserving exact sizing, colors, and accessibility attributes.`,
    });
  }

  // Emit Pillar 3 findings (Source-Mapping & JSX Blind Spots)
  if (staticJsxComponents.size > 0) {
    const compNames = [...staticJsxComponents.keys()];
    const allRefs = [...staticJsxComponents.entries()].flatMap(([name, refs]) =>
      refs.map((r) => ({ path: r.path, line: r.line, detail: `<${name}> rendered without client:*` })),
    );
    findings.push({
      id: findingId('static-jsx-components', allRefs[0]!.path),
      pillar: 'source_mapping',
      severity: 'medium',
      actionKind: 'agent_refactor',
      source: 'static',
      title: `Convert static JSX component${compNames.length === 1 ? '' : 's'} (${compNames.join(', ')}) to .astro`,
      description:
        'Framework components (`.tsx`/`.vue`) rendered without a `client:*` directive ship zero client interactivity yet strip Astro’s `data-astro-source-loc` attributes, blinding click-to-edit and element selection.',
      impactLabel: `Restores exact source-location mapping & inline editing on ${compNames.length} component${compNames.length === 1 ? '' : 's'}`,
      files: allRefs.slice(0, 6),
      scorePenalty: Math.min(10, 4 + compNames.length * 2),
      agentInstructions: `Convert the non-interactive framework component(s) (${compNames.join(', ')}) used without \`client:*\` directives into native \`.astro\` components so Astro emits source-location metadata and unlocks inline editing, preserving identical markup and Tailwind classes.`,
    });
  }

  // Emit Pillar 4 findings (Guardrails: AGENTS.md, Zod content.config, verify scripts)
  const agentsMd = texts.get('AGENTS.md') ?? '';
  if (!agentsMd.trim()) {
    findings.push({
      id: findingId('missing-agents-md', 'AGENTS.md'),
      pillar: 'guardrails',
      severity: 'high',
      actionKind: 'agent_refactor',
      source: 'static',
      title: 'Add an AGENTS.md guide tailored to this Astro site',
      description:
        'Without `AGENTS.md`, Haiku has to infer routing, base-path link helpers, asset folders, and typography conventions by reading extra files every session.',
      impactLabel: 'Gives Pi instant zero-turn repo conventions & fewer check failures',
      files: [{ path: 'AGENTS.md', detail: 'Missing file' }],
      scorePenalty: 10,
      agentInstructions: `Inspect \`astro.config.*\`, \`package.json\`, \`src/layouts/\`, \`src/components/\`, and \`public/\`, then create a concise, accurate \`AGENTS.md\` documenting base-path/link conventions${astroBase !== '/' ? ` (including \`base: '${astroBase}'\` subpath link handling)` : ''}, asset paths, content collection schemas, styling tokens, and verification commands.`,
    });
  } else if (astroBase !== '/' && !/\burl\s*\(|BASE_URL|base\b/i.test(agentsMd)) {
    findings.push({
      id: findingId('agents-md-subpath', 'AGENTS.md'),
      pillar: 'guardrails',
      severity: 'medium',
      actionKind: 'agent_refactor',
      source: 'static',
      title: `Document subpath base (\`${astroBase}\`) link rules in AGENTS.md`,
      description: `\`astro.config\` sets \`base: '${astroBase}'\`, but \`AGENTS.md\` does not mention subpath link/asset helpers—a common cause of broken links on GitHub Pages.`,
      impactLabel: 'Prevents root-relative link mistakes on first attempt',
      files: [{ path: 'AGENTS.md', line: 1 }],
      scorePenalty: 5,
      agentInstructions: `Update \`AGENTS.md\` to clearly document how internal links and \`public/\` asset paths must handle \`base: '${astroBase}'\` (referencing the repo's actual helper such as \`url()\` or \`import.meta.env.BASE_URL\`).`,
    });
  }

  const hasContentDir = treeEntries.some((e) => e.path.startsWith('src/content/') && !/config\.ts$/.test(e.path));
  const hasContentSchema =
    texts.has('src/content.config.ts') || texts.has('src/content/config.ts');
  if (hasContentDir && !hasContentSchema) {
    findings.push({
      id: findingId('missing-content-schema', 'src/content.config.ts'),
      pillar: 'guardrails',
      severity: 'medium',
      actionKind: 'agent_refactor',
      source: 'static',
      title: 'Add Zod schema validation (`src/content.config.ts`) for `src/content/`',
      description:
        'Typed Zod schemas turn malformed frontmatter or JSON typos into immediate `astro check` compiler errors that Haiku can self-correct deterministically.',
      impactLabel: 'Catches content schema mistakes during pre-publish checks',
      files: [{ path: 'src/content.config.ts', detail: 'Missing Zod collection schema' }],
      scorePenalty: 6,
      agentInstructions:
        'Inspect existing entries under `src/content/` and create a matching Zod collection schema in `src/content.config.ts` (Astro 5 Content Layer / collections format), verifying `npm run check` passes cleanly.',
    });
  }

  let pkgScripts: Record<string, string> = {};
  try {
    const parsedPkg = JSON.parse(texts.get('package.json') ?? '{}') as {
      scripts?: Record<string, string>;
    };
    pkgScripts = parsedPkg.scripts ?? {};
  } catch (err) {
    ignore(err, 'optimizer: parse package.json scripts');
    pkgScripts = {};
  }
  const hasVerifySeo = Boolean(pkgScripts['verify:seo']);
  if (!pkgScripts.check) {
    findings.push({
      id: findingId('missing-astro-check-script', 'package.json'),
      pillar: 'guardrails',
      severity: 'medium',
      actionKind: 'agent_refactor',
      source: 'static',
      title: 'Add `"check": "astro check"` script to `package.json`',
      description:
        'Halley automatically runs `npm run check` during verification when present, catching TypeScript and Astro template errors before publishing.',
      impactLabel: 'Enables automatic Astro & TypeScript pre-publish checking',
      files: [{ path: 'package.json', line: 1 }],
      scorePenalty: 5,
      agentInstructions:
        'Ensure `@astrojs/check` and `typescript` are available if already installed, or add an appropriate `"check"` script in `package.json` and confirm `run_checks` passes.',
    });
  }

  // Emit Pillar 5 findings (Assets, .gitignore, & GitHub Actions Workflows)
  let oversizedImageBytes = 0;
  for (const entry of treeEntries) {
    if (!entry.path.startsWith('public/') || !RASTER_IMAGE_RE.test(entry.path)) continue;
    if (entry.size < OVERSIZED_IMAGE_THRESHOLD_BYTES) continue;

    const publicRel = entry.path.slice('public/'.length);
    const baseName = path.basename(publicRel).toLowerCase();

    // Exclude OS/browser/PWA icons & default OpenGraph social cards
    if (
      /^(?:favicon|apple-touch-icon|android-chrome|mstile|safari-pinned|og-image|opengraph|social-card)/i.test(
        baseName,
      )
    ) {
      continue;
    }
    if (excludedImagePaths.has(publicRel)) continue;

    const dirRel = path.posix.dirname(publicRel);
    if ([...dynamicImageDirs].some((d) => dirRel === d || dirRel.startsWith(`${d}/`))) {
      continue;
    }

    oversizedImageBytes += entry.size;
    findings.push({
      id: findingId('oversized-image', entry.path),
      pillar: 'speed_and_ci',
      severity: entry.size >= 1024 * 1024 ? 'high' : 'medium',
      actionKind: 'deterministic_webp',
      source: 'static',
      title: `Convert \`${publicRel}\` (${formatBytes(entry.size)}) to WebP`,
      description:
        'Deterministic $0 `sharp` pre-pass encodes WebP (quality 84), updates all static references in `src/`, and removes the oversized raster file to shrink `dist/` and speed up Pages uploads.',
      impactLabel: `$0 instant WebP conversion · shrinks ${formatBytes(entry.size)} image`,
      files: [{ path: entry.path, detail: formatBytes(entry.size) }],
      scorePenalty: entry.size >= 1024 * 1024 ? 5 : 3,
      webpCandidate: {
        publicRelPath: publicRel,
        bytes: entry.size,
      },
    });
  }

  const gitignoreText = texts.get('.gitignore') ?? '';
  const hasAstroIgnored = /^\s*\/?\.astro\/?\s*$/m.test(gitignoreText);
  const hasDistIgnored = /^\s*\/?dist\/?\s*$/m.test(gitignoreText);
  if (!hasAstroIgnored || !hasDistIgnored) {
    findings.push({
      id: findingId('gitignore-build-dirs', '.gitignore'),
      pillar: 'speed_and_ci',
      severity: 'low',
      actionKind: 'deterministic_gitignore',
      source: 'static',
      title: 'Add `.astro/` and `dist/` to `.gitignore`',
      description:
        'Ensures local developer builds and warm `.astro/` caches are ignored cleanly across all Git tooling.',
      impactLabel: '$0 instant `.gitignore` hygiene fix',
      files: [{ path: '.gitignore', line: 1 }],
      scorePenalty: 3,
    });
  }

  // Inspect .github/workflows/*.yml
  let hasSingleJobDeploy = false;
  for (const [wfPath, wfText] of texts.entries()) {
    if (!wfPath.startsWith('.github/workflows/') || !/\.ya?ml$/i.test(wfPath)) continue;

    const isPagesDeploy = /actions\/deploy-pages/.test(wfText);
    if (isPagesDeploy) {
      const hasSeparateBuildJob = /\bneeds\s*:\s*\[?\s*build\b/.test(wfText);
      const lacksNodeCache =
        /withastro\/action/.test(wfText) || !/cache\s*:\s*['"]?(?:npm|pnpm|yarn)/.test(wfText);
      if (hasSeparateBuildJob || lacksNodeCache) {
        const yamlContent = buildRecommendedDeployYaml({
          baseBranch: opts.baseBranch,
          usePnpm: hasPnpmLock,
          hasVerifySeo,
        });
        findings.push({
          id: findingId('two-job-pages-deploy', wfPath),
          pillar: 'speed_and_ci',
          severity: 'medium',
          actionKind: 'workflow_yaml',
          source: 'static',
          title: `Collapse \`${path.basename(wfPath)}\` into a single cached GitHub Pages job`,
          description:
            'Eliminates spinning up a second `ubuntu-latest` VM between `build` and `deploy`, enables explicit `setup-node` lockfile caching, and runs SEO checks before upload.',
          impactLabel: 'Saves ~8–12s on every live Pages deployment',
          files: [{ path: wfPath, line: 1 }],
          scorePenalty: 5,
          workflowSuggestion: {
            targetPath: wfPath,
            githubEditUrl: `https://github.com/${opts.repoSlug}/edit/${opts.baseBranch}/${wfPath}`,
            yamlContent,
          },
        });
      } else {
        hasSingleJobDeploy = true;
      }
    }
  }

  // Check duplicate push: main CI workflow when Pages deploy workflow already builds on main
  for (const [wfPath, wfText] of texts.entries()) {
    if (!wfPath.startsWith('.github/workflows/') || !/\.ya?ml$/i.test(wfPath)) continue;
    if (/actions\/deploy-pages/.test(wfText)) continue;
    const hasPrTrigger = /\bpull_request\s*:/.test(wfText);
    const hasPushMainTrigger =
      new RegExp(`\\bpush\\s*:[\\s\\S]{0,80}\\bbranches\\s*:\\s*\\[[^\\]]*\\b${opts.baseBranch}\\b`).test(
        wfText,
      );
    if (hasPrTrigger && hasPushMainTrigger && (hasSingleJobDeploy || texts.has('.github/workflows/deploy.yml'))) {
      const updatedCi = wfText.replace(
        /\n\s*push\s*:\s*\n\s*branches\s*:\s*\[[^\]]*\]/m,
        '\n  workflow_dispatch:',
      );
      findings.push({
        id: findingId('duplicate-push-ci', wfPath),
        pillar: 'speed_and_ci',
        severity: 'low',
        actionKind: 'workflow_yaml',
        source: 'static',
        title: `Remove duplicate \`push: ${opts.baseBranch}\` build from \`${path.basename(wfPath)}\``,
        description:
          'PRs already run full CI before merging, and `deploy.yml` already builds on `main` pushes—running both burns a duplicate Actions runner on every publish.',
        impactLabel: 'Cuts post-merge GitHub Actions runner usage by 50%',
        files: [{ path: wfPath, line: 1 }],
        scorePenalty: 3,
        workflowSuggestion: {
          targetPath: wfPath,
          githubEditUrl: `https://github.com/${opts.repoSlug}/edit/${opts.baseBranch}/${wfPath}`,
          yamlContent: updatedCi,
        },
      });
    }
  }

  // PR CI steps that Halley's own pre-publish checks do not run
  const ciCoverage = analyzeCiCoverage(
    [...texts.entries()]
      .filter(([p]) => p.startsWith('.github/workflows/') && /\.ya?ml$/i.test(p))
      .map(([p, text]) => ({ path: p, text })),
    { halleyCheckCommands: parseHalleyCheckCommands(texts.get('.halley.json')) },
  );
  for (const wfPath of new Set(ciCoverage.gaps.map((g) => g.workflow))) {
    const gaps = ciCoverage.gaps.filter((g) => g.workflow === wfPath);
    const runner = hasPnpmLock ? 'pnpm' : 'npm';
    findings.push({
      id: findingId('ci-only-checks', wfPath),
      pillar: 'speed_and_ci',
      severity: 'medium',
      actionKind: 'agent_refactor',
      source: 'static',
      title: `Move ${gaps.length} CI-only check${gaps.length === 1 ? '' : 's'} in \`${path.basename(wfPath)}\` into \`verify:*\` scripts`,
      description:
        'These pull-request CI steps are not part of Halley\'s pre-publish checks, so editors only learn about a failure after the PR is opened, and Halley has to wait for CI on every publish (`HALLEY_PUBLISH_SKIP_CI` stays inactive). Halley runs every `verify:*` script in `package.json` before publishing. After the scripts exist, replace each step in the workflow with the matching `' +
        runner +
        ' run verify:<name>` call on GitHub (Halley cannot edit `.github/`).',
      impactLabel: 'Catches failures before the PR · lets publishes skip the ~25–35s CI wait',
      files: gaps.map((g) => ({ path: wfPath, line: g.line, detail: `${g.step}: ${g.detail}` })),
      scorePenalty: 4,
      agentInstructions: `The pull-request workflow \`${wfPath}\` has steps that Halley's pre-publish checks do not run: ${gaps
        .map((g) => `"${g.step}" (line ${g.line})`)
        .join(', ')}. Read the workflow, then reproduce each step's logic as a zero-dependency Node script under \`scripts/\` exposed as a \`verify:<name>\` script in \`package.json\` (it runs after \`build\`, from the repo root, and must exit non-zero on failure). Do not edit anything under \`.github/\`. Confirm \`run_checks\` passes, then tell the user exactly which workflow steps to replace with \`${runner} run verify:<name>\` on GitHub.`,
    });
  }

  const inlineEditablePct =
    totalTextElements > 0
      ? Math.round((inlineEditableElements / totalTextElements) * 1000) / 10
      : 100;

  const metrics: AstroAuditMetricsDto = {
    totalTextElements,
    inlineEditableElements,
    inlineEditablePct,
    intentionalDynamicElements,
    avoidableLockedElements,
    astroPageCount,
    oversizedImageBytes,
  };

  const { score, pillarScores } = computeAuditScore(findings);
  const now = new Date().toISOString();

  const report: AstroAuditReportDto = {
    id: `audit-${sha.slice(0, 12)}`,
    sha,
    shortSha: sha.slice(0, 7),
    baseBranch: opts.baseBranch,
    score,
    pillarScores,
    metrics,
    findings,
    aiReviewedAt: null,
    aiSummary: null,
    aiCostUsd: 0,
    createdAt: now,
  };

  const digest = buildArchitectureDigest({
    repoSlug: opts.repoSlug,
    baseBranch: opts.baseBranch,
    sha,
    treeEntries,
    texts,
    report,
  });

  return { sha, report, digest };
}

function buildArchitectureDigest(input: {
  repoSlug: string;
  baseBranch: string;
  sha: string;
  treeEntries: TreeEntry[];
  texts: Map<string, string>;
  report: AstroAuditReportDto;
}): string {
  const parts: string[] = [];
  parts.push(
    `# Repository Architecture Digest: ${input.repoSlug} (${input.baseBranch} @ ${input.sha.slice(0, 7)})`,
  );
  parts.push(
    `Static Readiness Score: ${input.report.score}/100 | Inline-Editable Copy: ${input.report.metrics.inlineEditablePct}% (${input.report.metrics.inlineEditableElements}/${input.report.metrics.totalTextElements})`,
  );

  // 1. File tree summary (capped)
  const treeLines = input.treeEntries
    .slice(0, 220)
    .map((e) => `${e.path} (${formatBytes(e.size)})`);
  parts.push(`## File Tree (${input.treeEntries.length} files)\n${treeLines.join('\n')}`);

  // 2. Existing static findings (so AI doesn't duplicate them)
  const staticList =
    input.report.findings.map((f) => `- [${f.pillar}] ${f.title} (${f.files.map((x) => x.path).join(', ')})`).join('\n') ||
    '(none)';
  parts.push(`## Already Detected Static Findings (do NOT repeat these)\n${staticList}`);

  // 3. Key config files
  for (const keyFile of [
    'package.json',
    'astro.config.mjs',
    'astro.config.ts',
    'AGENTS.md',
    'src/content.config.ts',
    'src/content/config.ts',
  ]) {
    const content = input.texts.get(keyFile);
    if (content) {
      parts.push(`## ${keyFile}\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``);
    }
  }

  // 4. Representative layouts, components, and largest pages (bounded to ~32KB total)
  let snippetBudget = 32_000;
  const candidateFiles = [...input.texts.entries()]
    .filter(([p]) => p.startsWith('src/') && /\.(astro|ts|tsx)$/.test(p))
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 12);

  for (const [filePath, text] of candidateFiles) {
    if (snippetBudget <= 0) break;
    const slice = text.slice(0, Math.min(3500, snippetBudget));
    snippetBudget -= slice.length;
    parts.push(`## Sample: ${filePath}\n\`\`\`astro\n${slice}\n\`\`\``);
  }

  return parts.join('\n\n');
}

export interface DeterministicPrePassResult {
  checkpoint: CheckpointInfo | null;
  completedSummaries: string[];
  agentFindings: OptimizationFindingDto[];
}

async function listSrcTextFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdirEntriesOrEmpty(dir, 'optimizer: list source directory');
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listSrcTextFiles(full)));
    } else if (/\.(astro|ts|tsx|js|jsx|mjs|json|md|mdx|css)$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Runs $0 deterministic optimizations (`sharp` PNG/JPG -> WebP + exact reference rewrites
 * + safe deletion of replaced originals + `.gitignore` updates) before any AI turn begins.
 */
export async function runDeterministicOptimizationPrePass(
  repoRoot: string,
  findings: OptimizationFindingDto[],
  identity: GitIdentity,
): Promise<DeterministicPrePassResult> {
  const completedSummaries: string[] = [];
  const agentFindings = findings.filter((f) => f.actionKind === 'agent_refactor');

  const webpFindings = findings.filter(
    (f) => f.actionKind === 'deterministic_webp' && f.webpCandidate?.publicRelPath,
  );
  if (webpFindings.length > 0) {
    const srcFiles = await listSrcTextFiles(path.join(repoRoot, 'src'));
    const fileContents = new Map<string, string>();
    for (const sf of srcFiles) {
      fileContents.set(sf, await fs.readFile(sf, 'utf8'));
    }

    const dirtySrcFiles = new Set<string>();

    for (const f of webpFindings) {
      const rel = f.webpCandidate!.publicRelPath.replace(/^\/+/, '');
      const absOld = path.join(repoRoot, 'public', rel);
      const parsed = path.posix.parse(rel);
      const newRel = path.posix.join(parsed.dir, `${parsed.name}.webp`).replace(/^\.\//, '');
      const absNew = path.join(repoRoot, 'public', newRel);

      let oldBuf: Buffer;
      try {
        oldBuf = await fs.readFile(absOld);
      } catch (err) {
        // the image was removed since the scan: nothing to convert
        if (!isMissingPathError(err)) ignore(err, 'optimizer: read image for webp conversion', { absOld });
        continue;
      }

      const webpBuf = await sharp(oldBuf).rotate().webp({ quality: 84 }).toBuffer();
      if (webpBuf.length >= oldBuf.length) {
        continue;
      }

      await writeFileAtomic(absNew, webpBuf);

      // Rewrite exact path occurrences (`/images/foo.png` and `images/foo.png`) in src/
      const oldWithSlash = `/${rel}`;
      const newWithSlash = `/${newRel}`;
      let rewrittenRefs = 0;
      for (const [sf, text] of fileContents.entries()) {
        let updated = text;
        if (updated.includes(oldWithSlash)) {
          updated = updated.split(oldWithSlash).join(newWithSlash);
        }
        if (updated.includes(rel)) {
          updated = updated.split(rel).join(newRel);
        }
        if (updated !== text) {
          fileContents.set(sf, updated);
          dirtySrcFiles.add(sf);
          rewrittenRefs += 1;
        }
      }

      // Safely delete the original oversized PNG/JPG so dist/ shrinks
      await fs.rm(absOld, { force: true });
      completedSummaries.push(
        `Converted \`public/${rel}\` (${formatBytes(oldBuf.length)}) → \`public/${newRel}\` (${formatBytes(webpBuf.length)}, updated ${rewrittenRefs} file${rewrittenRefs === 1 ? '' : 's'})`,
      );
    }

    for (const sf of dirtySrcFiles) {
      await writeFileAtomic(sf, fileContents.get(sf)!);
    }
  }

  const gitignoreFindings = findings.filter((f) => f.actionKind === 'deterministic_gitignore');
  if (gitignoreFindings.length > 0) {
    const giPath = path.join(repoRoot, '.gitignore');
    let content = await readFileOr(giPath, '', 'optimizer: read .gitignore');
    const toAppend: string[] = [];
    if (!/^\s*\/?dist\/?\s*$/m.test(content)) toAppend.push('dist/');
    if (!/^\s*\/?\.astro\/?\s*$/m.test(content)) toAppend.push('.astro/');
    if (toAppend.length > 0) {
      const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      content = `${content}${prefix}${toAppend.join('\n')}\n`;
      await writeFileAtomic(giPath, content);
      completedSummaries.push(`Added ${toAppend.join(', ')} to \`.gitignore\``);
    }
  }

  let checkpoint: CheckpointInfo | null = null;
  if (completedSummaries.length > 0) {
    checkpoint = await createCheckpoint(
      repoRoot,
      `Optimize static assets & config (${completedSummaries.length} item${completedSummaries.length === 1 ? '' : 's'})`,
      identity,
    );
  }

  return {
    checkpoint,
    completedSummaries,
    agentFindings,
  };
}

export function buildOptimizationPrompt(opts: {
  agentFindings: OptimizationFindingDto[];
  completedDeterministic: string[];
}): string {
  const lines: string[] = [
    'Please apply the following selected **Optimize Astro for Halley** improvements to this repository.',
    '',
  ];

  if (opts.completedDeterministic.length > 0) {
    lines.push(
      '### Already Completed Deterministically ($0 Pre-Pass)',
      ...opts.completedDeterministic.map((s) => `- ${s}`),
      '',
    );
  }

  lines.push('### Selected Structural Optimizations to Implement');
  opts.agentFindings.forEach((f, idx) => {
    const fileRefs = f.files
      .map((fl) => (fl.line ? `\`${fl.path}:${fl.line}\`` : `\`${fl.path}\``))
      .join(', ');
    lines.push(
      `${idx + 1}. **${f.title}** (${fileRefs || 'repository'})`,
      `   - Why: ${f.description}`,
      `   - Instructions: ${f.agentInstructions || f.description}`,
    );
  });

  lines.push(
    '',
    '### Strict Requirements',
    '1. **Zero visual regressions:** Every refactored component or page must render pixel-identically on both desktop and mobile (preserve exact HTML semantics, Tailwind classes, spacing, and copy).',
    '2. **Verify visually & deterministically:** If you touch any `.astro` page or component, use `screenshot_page` (`viewport: "both"`) on an affected route to confirm visual fidelity, and run `run_checks` at the end to ensure `astro check`, production `build`, and any `verify:*` scripts pass with 0 errors.',
    '3. Keep changes focused strictly on the selected items above and never touch `.github/**`.',
  );

  return lines.join('\n');
}
