import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@astrojs/compiler';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { inspectAstroElement, parseLoc, sha256 } from './ast-classifier.js';
import type { AsyncFileLock } from './file-lock.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

export interface SerializeOptions {
  previewBase: string;
  originalBase: string;
  hasUrlHelperFile: boolean;
}

export interface SerializeResult {
  astroSource: string;
  needsUrlImport: boolean;
}

const SAFE_PASSTHROUGH_ATTRS = new Set([
  'id',
  'class',
  'style',
  'title',
  'lang',
  'dir',
  'download',
  'hreflang',
  'type',
]);

function isSafePassthroughAttr(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('data-astro-source-')) return false;
  if (lower === 'contenteditable' || lower === 'spellcheck') return false;
  if (lower.startsWith('on')) return false;
  if (SAFE_PASSTHROUGH_ATTRS.has(lower)) return true;
  if (lower.startsWith('aria-') || lower.startsWith('data-')) return true;
  return false;
}

function serializePassthroughAttrs(
  el: Element,
  skipLowerNames: Set<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const attr of el.attrs) {
    const lower = attr.name.toLowerCase();
    if (skipLowerNames.has(lower)) continue;
    if (!isSafePassthroughAttr(lower)) continue;
    if (attr.value === '') {
      out.push(`${lower}=""`);
    } else {
      out.push(`${lower}="${escapeAttr(attr.value)}"`);
    }
  }
  return out;
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

export function escapeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getAttr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value;
}

export function normalizeHref(rawHref: string, previewBase: string, originalBase: string): {
  kind: 'internal' | 'external' | 'invalid';
  value: string;
} {
  const trimmed = rawHref.trim();
  if (!trimmed) return { kind: 'invalid', value: '' };

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('file:')
  ) {
    return { kind: 'invalid', value: '' };
  }

  // Strip full preview origin if browser resolved relative href
  let candidate = trimmed;
  try {
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      const parsed = new URL(candidate);
      if (previewBase !== '/' && parsed.pathname.startsWith(previewBase)) {
        candidate = parsed.pathname + parsed.search + parsed.hash;
      }
    }
  } catch {
    // ignore invalid URL
  }

  if (previewBase !== '/' && candidate.startsWith(previewBase)) {
    const rest = candidate.slice(previewBase.length);
    candidate = rest.startsWith('/') ? rest : `/${rest}`;
    return { kind: 'internal', value: candidate || '/' };
  }

  if (
    originalBase !== '/' &&
    candidate.startsWith(originalBase) &&
    (candidate.length === originalBase.length ||
      candidate[originalBase.length] === '/' ||
      candidate[originalBase.length] === '?' ||
      candidate[originalBase.length] === '#')
  ) {
    const rest = candidate.slice(originalBase.length);
    candidate = !rest || rest.startsWith('/') ? rest || '/' : `/${rest}`;
    return { kind: 'internal', value: candidate || '/' };
  }

  if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    return { kind: 'internal', value: candidate };
  }

  if (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    candidate.startsWith('#') ||
    candidate.startsWith('?') ||
    /^(?:\.\.?\/|[a-zA-Z0-9][a-zA-Z0-9._~/-]*)(?:[?#].*)?$/.test(candidate)
  ) {
    return { kind: 'external', value: candidate };
  }

  return { kind: 'invalid', value: '' };
}

export function serializeHtmlToAstro(
  newHtml: string,
  options: SerializeOptions,
): SerializeResult {
  const fragment = parseFragment(newHtml);
  let needsUrlImport = false;

  function serializeChildren(nodes: Node[]): string {
    let out = '';
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.nodeName === '#text') {
        out += escapeText((node as TextNode).value);
        continue;
      }
      if (node.nodeName === '#comment') {
        continue;
      }

      const el = node as Element;
      const tag = el.tagName.toLowerCase();

      if (tag === 'br') {
        out += '<br />';
        continue;
      }

      if (tag === 'strong' || tag === 'b') {
        const attrs = serializePassthroughAttrs(el);
        const inner = serializeChildren(el.childNodes);
        out += `<strong${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</strong>`;
        continue;
      }

      if (tag === 'em' || tag === 'i') {
        const attrs = serializePassthroughAttrs(el);
        const inner = serializeChildren(el.childNodes);
        out += `<em${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</em>`;
        continue;
      }

      if (tag === 'u' || tag === 'code' || tag === 'small' || tag === 'sup' || tag === 'sub') {
        const attrs = serializePassthroughAttrs(el);
        const inner = serializeChildren(el.childNodes);
        out += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${tag}>`;
        continue;
      }

      if (tag === 's' || tag === 'del' || tag === 'strike') {
        const attrs = serializePassthroughAttrs(el);
        const inner = serializeChildren(el.childNodes);
        out += `<s${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</s>`;
        continue;
      }

      if (tag === 'span') {
        const attrs = serializePassthroughAttrs(el);
        const inner = serializeChildren(el.childNodes);
        if (attrs.length > 0) {
          out += `<span ${attrs.join(' ')}>${inner}</span>`;
        } else {
          out += inner;
        }
        continue;
      }

      if (tag === 'a') {
        const rawHref = getAttr(el, 'href') ?? '';
        const norm = normalizeHref(rawHref, options.previewBase, options.originalBase);
        const inner = serializeChildren(el.childNodes);
        if (norm.kind === 'invalid') {
          out += inner;
          continue;
        }
        const target = getAttr(el, 'target');
        const rel = getAttr(el, 'rel');
        const extraAttrs = serializePassthroughAttrs(el, new Set(['href', 'target', 'rel']));
        if (target === '_blank') {
          extraAttrs.push('target="_blank"');
          extraAttrs.push(`rel="${escapeAttr(rel || 'noopener noreferrer')}"`);
        } else if (target) {
          extraAttrs.push(`target="${escapeAttr(target)}"`);
          if (rel) extraAttrs.push(`rel="${escapeAttr(rel)}"`);
        } else if (rel) {
          extraAttrs.push(`rel="${escapeAttr(rel)}"`);
        }

        if (norm.kind === 'internal' && options.hasUrlHelperFile) {
          needsUrlImport = true;
          const safePath = norm.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const attrsStr = extraAttrs.length ? ' ' + extraAttrs.join(' ') : '';
          out += `<a href={url('${safePath}')}${attrsStr}>${inner}</a>`;
        } else {
          const attrsStr = extraAttrs.length ? ' ' + extraAttrs.join(' ') : '';
          out += `<a href="${escapeAttr(norm.value)}"${attrsStr}>${inner}</a>`;
        }
        continue;
      }

      // Browsers sometimes wrap lines in <div> or <p> inside contenteditable
      if (tag === 'div' || tag === 'p') {
        const inner = serializeChildren(el.childNodes);
        if (i > 0 && out && !out.endsWith('<br />')) {
          out += '<br />';
        }
        out += inner;
        continue;
      }

      // Disallowed tags (<script>, <iframe>, <img>, etc.): drop scripts entirely, unwrap harmless containers
      if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
        continue;
      }
      out += serializeChildren(el.childNodes);
    }
    return out;
  }

  const astroSource = serializeChildren(fragment.childNodes);
  return { astroSource, needsUrlImport };
}

const URL_HELPER_CANDIDATES = [
  ['src', 'lib', 'url.ts'],
  ['src', 'lib', 'url.js'],
  ['src', 'utils', 'url.ts'],
  ['src', 'utils', 'url.js'],
  ['src', 'helpers', 'url.ts'],
];

export async function resolveUrlHelperAbs(repoRoot: string): Promise<string | null> {
  for (const parts of URL_HELPER_CANDIDATES) {
    const candidate = path.join(repoRoot, ...parts);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

export async function injectUrlImportIfMissing(
  source: string,
  filePath: string,
  urlHelperAbs: string,
): Promise<string> {
  if (/\bimport\s+\{[^}]*\burl\b[^}]*\}\s+from\s+['"][^'"]+['"]/.test(source)) {
    return source;
  }
  let relImport = path.relative(path.dirname(filePath), urlHelperAbs).split(path.sep).join('/');
  relImport = relImport.replace(/\.(?:ts|js)$/, '');
  if (!relImport.startsWith('.')) relImport = `./${relImport}`;
  const importLine = `import { url } from '${relImport}';\n`;

  try {
    const parsed = await parse(source, { position: true });
    const children = (parsed.ast as { children?: Array<{ type: string; position?: { start?: { offset?: number } } }> })
      .children ?? [];
    const fmNode = children.find((c) => c.type === 'frontmatter');
    if (fmNode?.position?.start?.offset !== undefined) {
      const buf = Buffer.from(source, 'utf8');
      const fmStartChar = buf.subarray(0, fmNode.position.start.offset).toString('utf8').length;
      const firstNewline = source.indexOf('\n', fmStartChar);
      if (firstNewline !== -1) {
        return source.slice(0, firstNewline + 1) + importLine + source.slice(firstNewline + 1);
      }
    }
  } catch {
    // Fall back to safe frontmatter fence detection below
  }

  const trimmedFenceMatch = /^(\s*---[ \t]*\r?\n)/.exec(source);
  if (trimmedFenceMatch) {
    const insertAt = trimmedFenceMatch[1]!.length;
    return source.slice(0, insertAt) + importLine + source.slice(insertAt);
  }
  return `---\n${importLine}---\n${source}`;
}

export interface PatchStaticSpanInput {
  repoRoot: string;
  relFile: string;
  loc: string;
  expectedHash: string;
  newHtml: string;
  previewBase: string;
  originalBase: string;
  fileLock: AsyncFileLock;
}

export type PatchStaticSpanResult =
  | {
      ok: true;
      updatedSource: string;
      beforeSource: string;
      afterSource: string;
      newHash: string;
      newOuterHash: string;
      newLoc: string;
      topLineDelta: number;
      afterLine: number;
      afterLineDelta: number;
      sameLineEndCol: number;
      sameLineByteDelta: number;
    }
  | { ok: false; code: 400 | 404 | 409 | 422; error: string };

export function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

export function byteColumnInLastLine(text: string): number {
  const lastNl = text.lastIndexOf('\n');
  const tail = lastNl === -1 ? text : text.slice(lastNl + 1);
  return Buffer.byteLength(tail, 'utf8') + 1;
}

export async function patchStaticSpan(
  input: PatchStaticSpanInput,
): Promise<PatchStaticSpanResult> {
  const absPath = path.resolve(input.repoRoot, input.relFile);
  if (!absPath.startsWith(path.resolve(input.repoRoot) + path.sep)) {
    return { ok: false, code: 400, error: 'Invalid file path' };
  }
  if (input.relFile === '.github' || input.relFile.startsWith('.github/')) {
    return { ok: false, code: 400, error: '.github/** is protected' };
  }

  const urlHelperAbs = await resolveUrlHelperAbs(input.repoRoot);
  const hasUrlHelperFile = Boolean(urlHelperAbs);

  return input.fileLock.withLock(input.relFile, async () => {
    let source: string;
    try {
      source = await fs.readFile(absPath, 'utf8');
    } catch {
      return { ok: false, code: 404, error: `File not found: ${input.relFile}` };
    }

    const inspected = await inspectAstroElement(source, input.loc, input.relFile);
    if (!inspected) {
      return { ok: false, code: 404, error: `Element not found at ${input.loc}` };
    }
    if (inspected.editability !== 'editable-static') {
      return { ok: false, code: 422, error: `Element is dynamic: ${inspected.reason}` };
    }
    if (inspected.snapshotHash !== input.expectedHash) {
      return {
        ok: false,
        code: 409,
        error: 'File changed on disk since you started editing. Please re-click to refresh.',
      };
    }

    const { astroSource, needsUrlImport } = serializeHtmlToAstro(input.newHtml, {
      previewBase: input.previewBase,
      originalBase: input.originalBase,
      hasUrlHelperFile,
    });

    const originalInner = source.slice(inspected.innerStartOffset, inspected.innerEndOffset);
    const prefixBeforeEnd = source.slice(0, inspected.innerEndOffset);
    const afterLine = countNewlines(prefixBeforeEnd) + 1;
    const sameLineEndCol = byteColumnInLastLine(prefixBeforeEnd);
    const afterLineDelta = countNewlines(astroSource) - countNewlines(originalInner);

    let sameLineByteDelta = 0;
    if (afterLineDelta === 0 && countNewlines(astroSource) === 0 && countNewlines(originalInner) === 0) {
      sameLineByteDelta = Buffer.byteLength(astroSource, 'utf8') - Buffer.byteLength(originalInner, 'utf8');
    } else {
      const newEndCol = byteColumnInLastLine(source.slice(0, inspected.innerStartOffset) + astroSource);
      sameLineByteDelta = newEndCol - sameLineEndCol;
    }

    let patched =
      source.slice(0, inspected.innerStartOffset) +
      astroSource +
      source.slice(inspected.innerEndOffset);

    let topLineDelta = 0;
    if (needsUrlImport && urlHelperAbs) {
      const beforeImportLines = countNewlines(patched);
      patched = await injectUrlImportIfMissing(patched, absPath, urlHelperAbs);
      topLineDelta = countNewlines(patched) - beforeImportLines;
    }

    const parsedInputLoc = parseLoc(input.loc);
    const newLoc = parsedInputLoc
      ? `${parsedInputLoc.line + topLineDelta}:${parsedInputLoc.column}`
      : input.loc;

    const reInspected = await inspectAstroElement(patched, newLoc, input.relFile).catch(() => null);
    const newHash = reInspected?.snapshotHash || sha256(astroSource);
    const newOuterHash = reInspected?.outerSnapshotHash || '';

    const tmpPath = `${absPath}.halley-tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, patched, 'utf8');
    await fs.rename(tmpPath, absPath);

    return {
      ok: true,
      updatedSource: astroSource,
      beforeSource: source,
      afterSource: patched,
      newHash,
      newOuterHash,
      newLoc,
      topLineDelta,
      afterLine,
      afterLineDelta,
      sameLineEndCol,
      sameLineByteDelta,
    };
  });
}
