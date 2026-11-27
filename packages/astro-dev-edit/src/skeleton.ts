import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@astrojs/compiler';
import { HALLEY_PLACEHOLDER_ATTR } from '@halley/shared';
import * as parse5 from 'parse5';
import { discoverSiteRoutes } from './routes.js';

interface AstAttr {
  type: string;
  name?: string;
  kind?: string;
  value?: string;
}

interface AstNode {
  type: string;
  name?: string;
  value?: string;
  attributes?: AstAttr[];
  children?: AstNode[];
}

export interface GeneratePageSkeletonOptions {
  repoRoot: string;
  title: string;
  route: string;
  targetFileRel: string;
  styleLikeRoute?: string;
  unlisted: boolean;
  purpose?: string;
}

export interface GeneratePageSkeletonResult {
  content: string;
  usedReferenceFile?: string;
  layoutName?: string;
}

function escapeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDraftDescription(title: string, purpose?: string): string {
  const cleanPurpose = (purpose ?? '').replace(/\s+/g, ' ').trim();
  if (cleanPurpose.length >= 32) {
    return cleanPurpose.length > 155 ? `${cleanPurpose.slice(0, 152).trimEnd()}…` : cleanPurpose;
  }
  const base = cleanPurpose
    ? `${title} — ${cleanPurpose}`
    : `Learn more about ${title}, including details, schedule, and how to get involved.`;
  if (base.length < 32) {
    return `${base} Details and information for visitors and our community.`.slice(0, 155);
  }
  return base.length > 155 ? `${base.slice(0, 152).trimEnd()}…` : base;
}

function parseDefaultImports(frontmatter: string): Map<string, string> {
  const imports = new Map<string, string>();
  const defaultRe = /^\s*import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  let m: RegExpExecArray | null;
  while ((m = defaultRe.exec(frontmatter)) !== null) {
    imports.set(m[1]!, m[2]!);
  }
  const namedRe = /^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  while ((m = namedRe.exec(frontmatter)) !== null) {
    const spec = m[2]!;
    for (const part of m[1]!.split(',')) {
      const cleaned = part.trim().replace(/^type\s+/, '');
      if (!cleaned) continue;
      const aliasMatch = /^([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/.exec(cleaned);
      const localName = aliasMatch?.[2] || aliasMatch?.[1];
      if (localName && /^[A-Z]/.test(localName)) {
        imports.set(localName, spec);
      }
    }
  }
  return imports;
}

function rewriteImportSpecifier(specifier: string, refFileAbs: string, targetFileAbs: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const resolved = path.resolve(path.dirname(refFileAbs), specifier);
  let rel = path.relative(path.dirname(targetFileAbs), resolved).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function findFirstComponent(nodes: AstNode[]): AstNode | null {
  for (const n of nodes) {
    if (n.type === 'component' && n.name) return n;
  }
  return null;
}

function sectionEyebrowFromRoute(route: string): string | undefined {
  const parts = route.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const sec = parts[parts.length - 2]!;
  return sec
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function inspectLayoutCapabilities(
  refFileAbs: string,
  layoutSpecifier: string,
): Promise<{ supportsIndexable: boolean; supportsDescription: boolean; hasHeadSlot: boolean }> {
  let layoutAbs: string | null = null;
  if (layoutSpecifier.startsWith('.')) {
    layoutAbs = path.resolve(path.dirname(refFileAbs), layoutSpecifier);
  } else if (layoutSpecifier.startsWith('@/') || layoutSpecifier.startsWith('~/')) {
    // Walk up to locate the nearest `src/` ancestor for aliased imports like `@/layouts/BaseLayout.astro`
    const normalized = refFileAbs.split(path.sep).join('/');
    const srcIdx = normalized.lastIndexOf('/src/');
    if (srcIdx !== -1) {
      const srcRoot = normalized.slice(0, srcIdx + '/src'.length);
      layoutAbs = path.resolve(srcRoot, layoutSpecifier.slice(2));
    }
  }
  if (!layoutAbs) {
    return { supportsIndexable: false, supportsDescription: true, hasHeadSlot: false };
  }
  try {
    const src = await fs.readFile(layoutAbs, 'utf8');
    const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
    return {
      supportsIndexable: /\bindexable\b/.test(fm),
      supportsDescription: /\bdescription\b/.test(fm),
      hasHeadSlot: /<slot\b[^>]*name=["']head["']/.test(src),
    };
  } catch {
    return { supportsIndexable: false, supportsDescription: true, hasHeadSlot: false };
  }
}

async function pickReferenceAstroFile(
  repoRoot: string,
  styleLikeRoute?: string,
): Promise<{ fileAbs: string; fileRel: string; source: string } | null> {
  const routes = await discoverSiteRoutes(repoRoot);
  const astroRoutes = routes.filter((r) => r.file?.endsWith('.astro'));

  if (styleLikeRoute && styleLikeRoute !== '__blank__') {
    const match = astroRoutes.find((r) => r.route === styleLikeRoute);
    if (match?.file) {
      const abs = path.join(repoRoot, match.file);
      try {
        const source = await fs.readFile(abs, 'utf8');
        return { fileAbs: abs, fileRel: match.file, source };
      } catch {
        // fall through to most common layout
      }
    }
  }

  // Find the most common outer layout across src/pages/**/*.astro
  const layoutCounts = new Map<string, { count: number; sample: { fileAbs: string; fileRel: string; source: string } }>();
  for (const r of astroRoutes) {
    if (!r.file) continue;
    const abs = path.join(repoRoot, r.file);
    try {
      const source = await fs.readFile(abs, 'utf8');
      const parsed = await parse(source, { position: false });
      const ast = parsed.ast as AstNode;
      const outer = findFirstComponent(ast.children ?? []);
      if (!outer?.name) continue;
      const fm = (ast.children ?? []).find((c) => c.type === 'frontmatter')?.value ?? '';
      const imports = parseDefaultImports(fm);
      if (!imports.has(outer.name)) continue;
      const key = outer.name;
      const existing = layoutCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        layoutCounts.set(key, { count: 1, sample: { fileAbs: abs, fileRel: r.file, source } });
      }
    } catch {
      // ignore unparseable pages
    }
  }

  let best: { count: number; sample: { fileAbs: string; fileRel: string; source: string } } | null = null;
  for (const entry of layoutCounts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.sample ?? null;
}

function buildPlaceholderMarkup(opts: { title: string; route: string; hasPageHeader: boolean }): string {
  const headingTag = opts.hasPageHeader ? 'h2' : 'h1';
  return [
    `  <section ${HALLEY_PLACEHOLDER_ATTR}="true" data-halley-route="${escapeAttr(opts.route)}" class="mx-auto max-w-3xl px-6 py-20 text-center">`,
    `    <div class="rounded-2xl border border-dashed border-amber-400/80 bg-amber-50/70 px-8 py-12 text-stone-800">`,
    `      <p class="text-xs font-semibold uppercase tracking-widest text-amber-800">Unfinished Page</p>`,
    `      <${headingTag} class="mt-2 text-2xl font-bold text-stone-900">${escapeHtml(opts.title)}</${headingTag}>`,
    `      <p class="mt-3 text-sm text-stone-600" data-halley-placeholder-status="true">Halley is writing this page…</p>`,
    `    </div>`,
    `  </section>`,
  ].join('\n');
}

export async function generatePageSkeleton(
  opts: GeneratePageSkeletonOptions,
): Promise<GeneratePageSkeletonResult> {
  const targetAbs = path.join(opts.repoRoot, opts.targetFileRel);
  const draftDesc = buildDraftDescription(opts.title, opts.purpose);
  const ref = await pickReferenceAstroFile(opts.repoRoot, opts.styleLikeRoute);

  if (ref) {
    try {
      const parsed = await parse(ref.source, { position: false });
      const ast = parsed.ast as AstNode;
      const children = ast.children ?? [];
      const fm = children.find((c) => c.type === 'frontmatter')?.value ?? '';
      const imports = parseDefaultImports(fm);
      const outer = findFirstComponent(children);

      if (outer?.name && imports.has(outer.name)) {
        const layoutName = outer.name;
        const layoutSpec = imports.get(layoutName)!;
        const rewrittenLayoutSpec = rewriteImportSpecifier(layoutSpec, ref.fileAbs, targetAbs);
        const caps = await inspectLayoutCapabilities(ref.fileAbs, layoutSpec);

        // Check for an immediate PageHeader-like component child
        const pageHeaderNode = (outer.children ?? []).find(
          (c) => c.type === 'component' && c.name === 'PageHeader' && imports.has('PageHeader'),
        );

        const importLines = [`import ${layoutName} from '${rewrittenLayoutSpec}';`];
        if (pageHeaderNode) {
          const phSpec = rewriteImportSpecifier(imports.get('PageHeader')!, ref.fileAbs, targetAbs);
          importLines.push(`import PageHeader from '${phSpec}';`);
        }

        const layoutAttrs: string[] = [`title="${escapeAttr(opts.title)}"`];
        const refUsedDesc = (outer.attributes ?? []).some((a) => a.name === 'description');
        if (caps.supportsDescription || refUsedDesc) {
          layoutAttrs.push(`description="${escapeAttr(draftDesc)}"`);
        }
        if (opts.unlisted && caps.supportsIndexable) {
          layoutAttrs.push('indexable={false}');
        }

        const innerLines: string[] = [];
        if (opts.unlisted && !caps.supportsIndexable) {
          innerLines.push(
            caps.hasHeadSlot
              ? '  <meta slot="head" name="robots" content="noindex" />'
              : '  <meta name="robots" content="noindex" />',
          );
        }

        if (pageHeaderNode) {
          const eyebrow = sectionEyebrowFromRoute(opts.route);
          const phAttrs = [`title="${escapeAttr(opts.title)}"`];
          if (eyebrow) phAttrs.push(`eyebrow="${escapeAttr(eyebrow)}"`);
          innerLines.push(`  <PageHeader ${phAttrs.join(' ')} />`);
        }

        innerLines.push(
          buildPlaceholderMarkup({
            title: opts.title,
            route: opts.route,
            hasPageHeader: Boolean(pageHeaderNode),
          }),
        );

        const content = [
          '---',
          ...importLines,
          '---',
          '',
          `<${layoutName} ${layoutAttrs.join(' ')}>`,
          ...innerLines,
          `</${layoutName}>`,
          '',
        ].join('\n');

        return {
          content,
          usedReferenceFile: ref.fileRel,
          layoutName,
        };
      }
    } catch {
      // fall back to minimal HTML skeleton
    }
  }

  // Fallback bare HTML Astro page (for sites without a shared layout component)
  const robotsLine = opts.unlisted ? '\n    <meta name="robots" content="noindex" />' : '';
  const content = `---
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
    <meta name="description" content="${escapeAttr(draftDesc)}" />${robotsLine}
  </head>
  <body>
    <main>
${buildPlaceholderMarkup({ title: opts.title, route: opts.route, hasPageHeader: false })}
    </main>
  </body>
</html>
`;

  return { content };
}

interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
}

function extractText(node: P5Node): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(extractText).join(' ');
}

function findElementsByTag(node: P5Node, tag: string, out: P5Node[]): void {
  if (node.tagName?.toLowerCase() === tag) {
    out.push(node);
  }
  for (const child of node.childNodes ?? []) {
    findElementsByTag(child, tag, out);
  }
}

/**
 * Extracts top-level navigation group labels from the live rendered homepage HTML.
 * Looks inside `<header>` `<nav>` (falling back to any `<nav>`), reading direct links/buttons
 * while avoiding dropdown sub-items and utility controls (Search, Menu, etc.).
 */
export function extractNavGroupsFromHtml(html: string): string[] {
  const doc = parse5.parse(html) as unknown as P5Node;
  const headers: P5Node[] = [];
  findElementsByTag(doc, 'header', headers);

  const navs: P5Node[] = [];
  for (const h of headers) {
    findElementsByTag(h, 'nav', navs);
  }
  if (navs.length === 0) {
    findElementsByTag(doc, 'nav', navs);
  }

  const seen = new Set<string>();
  const labels: string[] = [];
  const skipLabels = new Set(['home', 'search', 'menu', 'toggle menu', 'open menu', 'close', 'skip to content']);

  const collectFromNav = (nav: P5Node) => {
    // Walk top-level items; stop descending into nested dropdown menus or lists
    const walk = (node: P5Node, depth: number) => {
      if (depth > 4) return;
      const tag = node.tagName?.toLowerCase();
      if (tag === 'a' || tag === 'button') {
        const ariaLabel = node.attrs?.find((a) => a.name === 'aria-label')?.value?.trim();
        const text = extractText(node).replace(/\s+/g, ' ').trim();
        const label = text || ariaLabel || '';
        const lower = label.toLowerCase();
        if (label && label.length <= 40 && !skipLabels.has(lower) && !seen.has(lower)) {
          seen.add(lower);
          labels.push(label);
        }
        return;
      }
      // If a container has role="menu" or is a nested dropdown panel (absolute/hidden), skip its children
      const cls = node.attrs?.find((a) => a.name === 'class')?.value ?? '';
      if (depth > 1 && /\b(absolute|dropdown|submenu)\b/.test(cls)) return;
      for (const child of node.childNodes ?? []) {
        walk(child, depth + 1);
      }
    };
    walk(nav, 0);
  };

  for (const nav of navs.slice(0, 2)) {
    collectFromNav(nav);
  }

  return labels;
}

/**
 * Rewrites relative import specifiers inside an Astro file's frontmatter when moving it
 * from `fromFileAbs` to `toFileAbs`.
 */
export function rewriteRelativeImportsInAstroSource(
  source: string,
  fromFileAbs: string,
  toFileAbs: string,
): string {
  const fmMatch = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return source;
  const [full, open, body, close] = fmMatch;
  const updatedBody = body!.replace(
    /(\bfrom\s+['"]|\bimport\s+['"])(\.\.?\/[^'"]+)(['"])/g,
    (_m, pre: string, spec: string, post: string) => {
      const next = rewriteImportSpecifier(spec, fromFileAbs, toFileAbs);
      return `${pre}${next}${post}`;
    },
  );
  return `${open}${updatedBody}${close}${source.slice(full.length)}`;
}

function findOpeningTagEndIndex(source: string, tagStart: number): number | null {
  let i = tagStart;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let braceDepth = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const prev = i > 0 ? source[i - 1]! : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
    } else if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
    } else if (inBacktick) {
      if (ch === '`' && prev !== '\\') inBacktick = false;
    } else {
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '`') inBacktick = true;
      else if (ch === '{') braceDepth++;
      else if (ch === '}' && braceDepth > 0) braceDepth--;
      else if (ch === '>' && braceDepth === 0) return i;
    }
    i++;
  }
  return null;
}

function findComponentOpeningTagSpan(
  source: string,
  componentName: string,
): { start: number; end: number } | null {
  // Skip Astro frontmatter `--- ... ---` if present
  let searchFrom = 0;
  const fmMatch = source.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (fmMatch) {
    searchFrom = fmMatch[0].length;
  }
  const re = new RegExp(`<${componentName}(?=[\\s/>])`, 'g');
  re.lastIndex = searchFrom;
  const m = re.exec(source);
  if (!m) return null;
  const end = findOpeningTagEndIndex(source, m.index);
  if (end === null) return null;
  return { start: m.index, end };
}

/**
 * Toggles a page's unlisted/noindex state in its Astro source file.
 * Uses the outer layout's `indexable` prop when supported; otherwise manages
 * `<meta name="robots" content="noindex" />`.
 */
export async function togglePageUnlistedInSource(
  source: string,
  fileAbs: string,
  unlisted: boolean,
): Promise<string> {
  if (!unlisted) {
    let working = source;
    try {
      const parsed = await parse(source, { position: false });
      const ast = parsed.ast as AstNode;
      const children = ast.children ?? [];
      const outer = findFirstComponent(children);
      if (outer?.name) {
        const span = findComponentOpeningTagSpan(source, outer.name);
        if (span) {
          const openTag = source.slice(span.start, span.end + 1);
          const cleanedTag = openTag.replace(/\s+indexable\s*=\s*(?:\{\s*false\s*\}|["']false["'])/g, '');
          working = source.slice(0, span.start) + cleanedTag + source.slice(span.end + 1);
        }
      } else {
        working = source.replace(/\s+indexable\s*=\s*(?:\{\s*false\s*\}|["']false["'])/g, '');
      }
    } catch {
      working = source.replace(/\s+indexable\s*=\s*(?:\{\s*false\s*\}|["']false["'])/g, '');
    }
    return working
      .replace(/[ \t]*<meta\b[^>]*name=["']robots["'][^>]*noindex[^>]*\/?>[ \t]*\r?\n?/gi, '')
      .replace(/[ \t]*<meta\b[^>]*noindex[^>]*name=["']robots["'][^>]*\/?>[ \t]*\r?\n?/gi, '');
  }

  // Already unlisted?
  if (
    /\bindexable\s*=\s*(?:\{\s*false\s*\}|["']false["'])/.test(source) ||
    /<meta\b[^>]*name=["']robots["'][^>]*noindex/i.test(source) ||
    /<meta\b[^>]*noindex[^>]*name=["']robots["']/i.test(source)
  ) {
    return source;
  }

  let layoutSpan: { start: number; end: number } | null = null;
  try {
    const parsed = await parse(source, { position: false });
    const ast = parsed.ast as AstNode;
    const children = ast.children ?? [];
    const fm = children.find((c) => c.type === 'frontmatter')?.value ?? '';
    const imports = parseDefaultImports(fm);
    const outer = findFirstComponent(children);

    if (outer?.name && imports.has(outer.name)) {
      const layoutName = outer.name;
      const layoutSpec = imports.get(layoutName)!;
      const caps = await inspectLayoutCapabilities(fileAbs, layoutSpec);
      layoutSpan = findComponentOpeningTagSpan(source, layoutName);

      if (layoutSpan) {
        const openTag = source.slice(layoutSpan.start, layoutSpan.end + 1);
        if (caps.supportsIndexable) {
          if (/\bindexable\s*=\s*\{\s*true\s*\}/.test(openTag)) {
            const replacedTag = openTag.replace(/\bindexable\s*=\s*\{\s*true\s*\}/, 'indexable={false}');
            return source.slice(0, layoutSpan.start) + replacedTag + source.slice(layoutSpan.end + 1);
          }
          const isSelfClosing = openTag.endsWith('/>');
          const insertPos = isSelfClosing ? layoutSpan.end - 1 : layoutSpan.end;
          return `${source.slice(0, insertPos)} indexable={false}${source.slice(insertPos)}`;
        }

        if (caps.hasHeadSlot) {
          return `${source.slice(0, layoutSpan.end + 1)}\n  <meta slot="head" name="robots" content="noindex" />${source.slice(layoutSpan.end + 1)}`;
        }
      }
    }
  } catch {
    // fall through to <head> injection
  }

  if (/<\/head>/i.test(source)) {
    return source.replace(/<\/head>/i, '  <meta name="robots" content="noindex" />\n  </head>');
  }

  if (layoutSpan) {
    return `${source.slice(0, layoutSpan.end + 1)}\n  <meta name="robots" content="noindex" />${source.slice(layoutSpan.end + 1)}`;
  }

  return `${source}\n<meta name="robots" content="noindex" />\n`;
}

/**
 * Toggles `indexable: false` / `noindex: true` in Markdown/MDX YAML frontmatter.
 */
export function toggleMarkdownUnlistedInSource(source: string, unlisted: boolean): string {
  const fmMatch = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!unlisted) {
    if (!fmMatch) return source;
    const [, open, body, close] = fmMatch;
    const cleaned = body!
      .replace(/^[ \t]*(?:indexable\s*:\s*false|noindex\s*:\s*true)[ \t]*\r?\n?/gim, '')
      .replace(/\r?\n$/, '');
    return `${open}${cleaned}${close}${source.slice(fmMatch[0].length)}`;
  }

  if (fmMatch) {
    const [, open, body, close] = fmMatch;
    if (/\bindexable\s*:\s*false\b|\bnoindex\s*:\s*true\b/i.test(body!)) {
      return source;
    }
    const updatedBody = /\bindexable\s*:\s*true\b/i.test(body!)
      ? body!.replace(/\bindexable\s*:\s*true\b/i, 'indexable: false')
      : `${body!.replace(/\r?\n$/, '')}\nindexable: false`;
    return `${open}${updatedBody}${close}${source.slice(fmMatch[0].length)}`;
  }

  return `---\nindexable: false\n---\n\n${source}`;
}

