import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { inspectAstroElement } from './ast-classifier.js';
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

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

function escapeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getAttr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value;
}

function normalizeHref(rawHref: string, previewBase: string, originalBase: string): {
  kind: 'internal' | 'external' | 'invalid';
  value: string;
} {
  const trimmed = rawHref.trim();
  if (!trimmed) return { kind: 'invalid', value: '' };

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
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
    (candidate.length === originalBase.length || candidate[originalBase.length] === '/')
  ) {
    const rest = candidate.slice(originalBase.length);
    candidate = rest.startsWith('/') ? rest : `/${rest}`;
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
    candidate.startsWith('#')
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
        const inner = serializeChildren(el.childNodes);
        out += `<strong>${inner}</strong>`;
        continue;
      }

      if (tag === 'em' || tag === 'i') {
        const inner = serializeChildren(el.childNodes);
        out += `<em>${inner}</em>`;
        continue;
      }

      if (tag === 'span') {
        const cls = getAttr(el, 'class');
        const inner = serializeChildren(el.childNodes);
        if (cls) {
          out += `<span class="${escapeAttr(cls)}">${inner}</span>`;
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
        const cls = getAttr(el, 'class');
        const extraAttrs: string[] = [];
        if (cls) extraAttrs.push(`class="${escapeAttr(cls)}"`);
        if (target === '_blank') {
          extraAttrs.push('target="_blank"');
          extraAttrs.push(`rel="${escapeAttr(rel || 'noopener noreferrer')}"`);
        }

        if (norm.kind === 'internal' && options.hasUrlHelperFile) {
          needsUrlImport = true;
          const safePath = norm.value.replace(/'/g, "\\'");
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

function injectUrlImportIfMissing(
  source: string,
  filePath: string,
  repoRoot: string,
): string {
  if (/\bimport\s+\{[^}]*\burl\b[^}]*\}\s+from\s+['"][^'"]+['"]/.test(source)) {
    return source;
  }
  const urlHelperAbs = path.join(repoRoot, 'src', 'lib', 'url.ts');
  let relImport = path.relative(path.dirname(filePath), urlHelperAbs).split(path.sep).join('/');
  relImport = relImport.replace(/\.ts$/, '');
  if (!relImport.startsWith('.')) relImport = `./${relImport}`;
  const importLine = `import { url } from '${relImport}';\n`;

  if (source.startsWith('---\n') || source.startsWith('---\r\n')) {
    const firstNewline = source.indexOf('\n');
    return source.slice(0, firstNewline + 1) + importLine + source.slice(firstNewline + 1);
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
      newHash: string;
      topLineDelta: number;
      afterLine: number;
      afterLineDelta: number;
    }
  | { ok: false; code: 400 | 404 | 409 | 422; error: string };

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
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

  let hasUrlHelperFile = false;
  try {
    await fs.access(path.join(input.repoRoot, 'src', 'lib', 'url.ts'));
    hasUrlHelperFile = true;
  } catch {
    hasUrlHelperFile = false;
  }

  return input.fileLock.withLock(input.relFile, async () => {
    let source: string;
    try {
      source = await fs.readFile(absPath, 'utf8');
    } catch {
      return { ok: false, code: 404, error: `File not found: ${input.relFile}` };
    }

    const inspected = await inspectAstroElement(source, input.loc);
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
    const afterLine = countNewlines(source.slice(0, inspected.innerEndOffset)) + 1;
    const afterLineDelta = countNewlines(astroSource) - countNewlines(originalInner);

    // Preserve leading/trailing whitespace if the original template had formatting indentation
    let patched =
      source.slice(0, inspected.innerStartOffset) +
      astroSource +
      source.slice(inspected.innerEndOffset);

    let topLineDelta = 0;
    if (needsUrlImport) {
      const beforeImportLines = countNewlines(patched);
      patched = injectUrlImportIfMissing(patched, absPath, input.repoRoot);
      topLineDelta = countNewlines(patched) - beforeImportLines;
    }

    const tmpPath = `${absPath}.halley-tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, patched, 'utf8');
    await fs.rename(tmpPath, absPath);

    return {
      ok: true,
      updatedSource: astroSource,
      newHash: inspected.snapshotHash,
      topLineDelta,
      afterLine,
      afterLineDelta,
    };
  });
}
