import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@astrojs/compiler';
import { inlineEditingDisabledReason } from './compat.js';
import { ignoreMissingPath, warnUnexpected } from './diagnostics.js';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import crypto from 'node:crypto';
import {
  countAstroParseErrors,
  findElementsByContentHash,
  inspectAstroElement,
  parseLoc,
  sha256,
  type InspectResult,
  type SourceElement,
} from './ast-classifier.js';
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

/** Attributes the dev server / editor adds to rendered DOM that never belong in source. */
function isRuntimeOnlyAttr(lower: string): boolean {
  return (
    lower.startsWith('data-astro-source-') ||
    lower.startsWith('data-astro-cid-') ||
    lower === 'contenteditable' ||
    lower === 'spellcheck'
  );
}

function isSafePassthroughAttr(name: string): boolean {
  const lower = name.toLowerCase();
  if (isRuntimeOnlyAttr(lower)) return false;
  if (lower === 'contenteditable' || lower === 'spellcheck') return false;
  if (lower.startsWith('on')) return false;
  if (SAFE_PASSTHROUGH_ATTRS.has(lower)) return true;
  if (lower.startsWith('aria-') || lower.startsWith('data-')) return true;
  return false;
}

function serializePassthroughAttrs(
  el: Element,
  skipLowerNames: Set<string> = new Set(),
  /** Non-whitelisted attributes to keep anyway (they existed, unchanged, in the original source). */
  alsoAllow?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const attr of el.attrs) {
    const lower = attr.name.toLowerCase();
    if (skipLowerNames.has(lower)) continue;
    if (!isSafePassthroughAttr(lower) && !(alsoAllow?.has(lower) && !isRuntimeOnlyAttr(lower) && !lower.startsWith('on'))) {
      continue;
    }
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
  } catch (err) {
    // Expected for malformed absolute URLs (TypeError): keep the candidate as typed.
    if (!(err instanceof TypeError)) throw err;
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

/** Default text encoder for freshly written text: escapes, and keeps U+00A0 visible as &nbsp;. */
function encodeFreshText(text: string): string {
  return escapeText(text).replace(/\u00a0/g, '&nbsp;');
}

/**
 * Converts the edited element's DOM `innerHTML` back to Astro source.
 *
 * With `original` (the inspected span), unchanged parts are kept byte-for-byte from the source —
 * comments, entities (`&nbsp;`, `&mdash;` …), `{' '}` expressions, original tags (`<b>` stays
 * `<b>`) and all attributes of inline children — and only the parts whose rendered content changed
 * are re-serialized. Re-saving unchanged text is therefore a byte-for-byte no-op.
 */
export function serializeHtmlToAstro(
  newHtml: string,
  options: SerializeOptions,
  original?: Pick<InspectResult, 'innerSource' | 'innerTree'>,
): SerializeResult {
  const fragment = parseFragment(newHtml);
  if (original?.innerTree) {
    return reconcileWithSource(fragment.childNodes, original.innerSource, original.innerTree, options);
  }
  const fresh = createFreshSerializer(options, encodeFreshText);
  const astroSource = fresh.serializeChildren(fragment.childNodes);
  return { astroSource, needsUrlImport: fresh.needsUrlImport() };
}

function createFreshSerializer(
  options: SerializeOptions,
  encodeText: (text: string) => string,
  allowedStyleValues?: ReadonlySet<string>,
) {
  let needsUrlImport = false;

  function passthroughFor(el: Element, baseSkip?: Set<string>, keepAttrs?: ReadonlySet<string>): string[] {
    const skip = baseSkip ? new Set(baseSkip) : new Set<string>();
    if (allowedStyleValues && !keepAttrs?.has('style')) {
      const styleVal = getAttr(el, 'style');
      if (styleVal !== undefined && !allowedStyleValues.has(styleVal)) {
        skip.add('style');
      }
    }
    return serializePassthroughAttrs(el, skip, keepAttrs);
  }

  function serializeChildren(nodes: Node[]): string {
    let out = '';
    for (let i = 0; i < nodes.length; i++) {
      out = serializeNodeInto(out, nodes[i]!, i);
    }
    return out;
  }

  /** Appends the serialization of `node` (the i-th sibling) to `out` and returns the result. */
  function serializeNodeInto(out: string, node: Node, i: number, keepAttrs?: ReadonlySet<string>): string {
    {
      if (node.nodeName === '#text') {
        out += encodeText((node as TextNode).value);
        return out;
      }
      if (node.nodeName === '#comment') {
        return out;
      }

      if (!('tagName' in node)) return out;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();

      if (tag === 'br') {
        out += '<br />';
        return out;
      }

      if (tag === 'strong' || tag === 'b') {
        const attrs = passthroughFor(el, undefined, keepAttrs);
        const inner = serializeChildren(el.childNodes);
        out += `<strong${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</strong>`;
        return out;
      }

      if (tag === 'em' || tag === 'i') {
        const attrs = passthroughFor(el, undefined, keepAttrs);
        const inner = serializeChildren(el.childNodes);
        out += `<em${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</em>`;
        return out;
      }

      if (tag === 'u' || tag === 'code' || tag === 'small' || tag === 'sup' || tag === 'sub') {
        const attrs = passthroughFor(el, undefined, keepAttrs);
        const inner = serializeChildren(el.childNodes);
        out += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${tag}>`;
        return out;
      }

      if (tag === 's' || tag === 'del' || tag === 'strike') {
        const attrs = passthroughFor(el, undefined, keepAttrs);
        const inner = serializeChildren(el.childNodes);
        out += `<s${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</s>`;
        return out;
      }

      if (tag === 'span') {
        const attrs = passthroughFor(el, undefined, keepAttrs);
        const inner = serializeChildren(el.childNodes);
        if (attrs.length > 0) {
          out += `<span ${attrs.join(' ')}>${inner}</span>`;
        } else {
          out += inner;
        }
        return out;
      }

      if (tag === 'a') {
        const rawHref = getAttr(el, 'href') ?? '';
        const norm = normalizeHref(rawHref, options.previewBase, options.originalBase);
        const inner = serializeChildren(el.childNodes);
        if (norm.kind === 'invalid') {
          out += inner;
          return out;
        }
        const target = getAttr(el, 'target');
        const rel = getAttr(el, 'rel');
        const extraAttrs = passthroughFor(el, new Set(['href', 'target', 'rel']), keepAttrs);
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
        return out;
      }

      // Browsers sometimes wrap lines in <div> or <p> inside contenteditable
      if (tag === 'div' || tag === 'p') {
        const inner = serializeChildren(el.childNodes);
        if (i > 0 && out && !out.endsWith('<br />')) {
          out += '<br />';
        }
        out += inner;
        return out;
      }

      // Disallowed tags (<script>, <iframe>, <img>, etc.): drop scripts entirely, unwrap harmless containers
      if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
        return out;
      }
      out += serializeChildren(el.childNodes);
    }
    return out;
  }

  return { serializeChildren, serializeNodeInto, needsUrlImport: () => needsUrlImport };
}

// ---------------------------------------------------------------------------------------------
// Source-preserving reconciliation
// ---------------------------------------------------------------------------------------------

const HTML_WS = /[ \t\n\r\f]+/g;
/** `{' '}` / `{""}` style whitespace-only expressions (the only expressions in static spans). */
const WS_EXPR = /\{\s*(['"`])([ \t\n\r\f]*)\1\s*\}/g;
const COMMENT = /<!--[\s\S]*?-->/g;

/** Decodes HTML character references in `text` (text-content rules). */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  const frag = parseFragment(text.replace(/</g, '&lt;'));
  let out = '';
  for (const n of frag.childNodes) if (n.nodeName === '#text') out += (n as TextNode).value;
  return out;
}

/** What a run of static source (text, comments, `{' '}`) renders to, whitespace-collapsed. */
function canonicalSourceText(raw: string): string {
  return decodeEntities(raw.replace(COMMENT, '').replace(WS_EXPR, '$2')).replace(HTML_WS, ' ');
}

function canonicalDomText(nodes: Node[]): string {
  let out = '';
  for (const n of nodes) if (n.nodeName === '#text') out += (n as TextNode).value;
  return out.replace(HTML_WS, ' ');
}

type DomSegments = { runs: Node[][]; elements: Element[] };

/** Splits DOM children into n elements and the n+1 non-element runs around them. */
function segmentDom(nodes: Node[]): DomSegments {
  const runs: Node[][] = [[]];
  const elements: Element[] = [];
  for (const n of nodes) {
    if ('tagName' in n) {
      elements.push(n as Element);
      runs.push([]);
    } else if (n.nodeName === '#text' || n.nodeName === '#comment') {
      runs[runs.length - 1]!.push(n);
    }
  }
  return { runs, elements };
}

/** Source gaps (raw text between child elements) of a parent spanning [from, to). */
function sourceGaps(innerSource: string, children: SourceElement[], from: number, to: number): string[] {
  const gaps: string[] = [];
  let pos = from;
  for (const c of children) {
    gaps.push(innerSource.slice(pos, c.start));
    pos = c.end;
  }
  gaps.push(innerSource.slice(pos, to));
  return gaps;
}

function normalizeClass(value: string): string {
  return value
    .split(/\s+/)
    .filter((t) => t && !/^astro-[a-z0-9]+$/i.test(t))
    .join(' ');
}

function canonicalHref(raw: string, options: SerializeOptions): string {
  const norm = normalizeHref(raw, options.previewBase, options.originalBase);
  return `${norm.kind}:${norm.value}`;
}

function canonicalAttrMap(
  attrs: Array<{ name: string; value: string }>,
  tag: string,
  options: SerializeOptions,
): string {
  const entries: string[] = [];
  for (const a of attrs) {
    const lower = a.name.toLowerCase();
    if (isRuntimeOnlyAttr(lower)) continue;
    let value = a.value;
    if (lower === 'class') {
      value = normalizeClass(value);
      if (!value) continue;
    } else if (lower === 'href' && tag === 'a') {
      value = canonicalHref(value, options);
    }
    entries.push(`${lower}=${value}`);
  }
  return entries.sort().join('\u0000');
}

function sourceAttrsCanonical(el: SourceElement, options: SerializeOptions): string {
  return canonicalAttrMap(
    el.attrs.map((a) => {
      if (a.kind === 'expression') {
        // Static spans only allow href={url('/path')} here.
        const m = /^url\(\s*(['"`])([^'"`]+)\1\s*\)$/.exec(a.value.trim());
        return { name: a.name, value: m ? m[2]! : `{${a.value}}` };
      }
      return { name: a.name, value: a.kind === 'empty' ? '' : decodeEntities(a.value) };
    }),
    el.tag,
    options,
  );
}

function domAttrsCanonical(el: Element, options: SerializeOptions): string {
  return canonicalAttrMap(el.attrs, el.tagName.toLowerCase(), options);
}

function canonicalSourceElement(el: SourceElement, innerSource: string, options: SerializeOptions): string {
  const gaps =
    el.closeStart === null ? [] : sourceGaps(innerSource, el.children, el.openEnd, el.closeStart);
  let out = `<${el.tag} ${sourceAttrsCanonical(el, options)}>`;
  for (let i = 0; i < gaps.length; i++) {
    out += canonicalSourceText(gaps[i]!);
    if (i < el.children.length) out += canonicalSourceElement(el.children[i]!, innerSource, options);
  }
  return `${out}</${el.tag}>`;
}

function canonicalDomElement(el: Element, options: SerializeOptions): string {
  const tag = el.tagName.toLowerCase();
  const { runs, elements } = segmentDom(el.childNodes);
  let out = `<${tag} ${domAttrsCanonical(el, options)}>`;
  if (!VOID_DOM_TAGS.has(tag)) {
    for (let i = 0; i < runs.length; i++) {
      out += canonicalDomText(runs[i]!);
      if (i < elements.length) out += canonicalDomElement(elements[i]!, options);
    }
  }
  return `${out}</${tag}>`;
}

const VOID_DOM_TAGS = new Set(['br', 'wbr', 'img', 'hr', 'input']);

/**
 * Builds the text encoder for re-serialized runs: characters that the original span wrote as a
 * character reference (e.g. `&mdash;`, `&copy;`, `&#8203;`) are written the same way again, and
 * U+00A0 becomes `&nbsp;` unless the source used a raw U+00A0.
 */
function buildEntityEncoder(innerSource: string): (text: string) => string {
  const map = new Map<string, string>();
  for (const m of innerSource.matchAll(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi)) {
    const decoded = decodeEntities(m[0]);
    if (decoded.length > 0 && decoded.length <= 2 && decoded !== m[0] && !'&<>{}'.includes(decoded)) {
      if (!map.has(decoded)) map.set(decoded, m[0]);
    }
  }
  if (!map.has(' ') && !innerSource.includes(' ')) map.set(' ', '&nbsp;');
  return (text: string) => {
    let out = escapeText(text);
    for (const [ch, ent] of map) if (out.includes(ch)) out = out.split(ch).join(ent);
    return out;
  };
}

type RunToken = { canon: string; raw: string };

/**
 * Tokenizes a static source run for diffing: whitespace runs (raw whitespace, `{' '}`
 * expressions and comments next to them) are one token with canon ' ', character references are
 * one token with their decoded value, every other code point is its own token. Comments not next
 * to whitespace ride along in the raw text of the following (or, at the end, previous) token, so
 * they stay put whenever that token is unchanged.
 */
function tokenizeSourceRun(raw: string): RunToken[] {
  const tokens: RunToken[] = [];
  let pendingComments = '';
  const re = /(<!--[\s\S]*?-->)|((?:[ \t\n\r\f]|\{\s*(['"`])[ \t\n\r\f]*\3\s*\})+)|(&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)|([\s\S])/giu;
  for (const m of raw.matchAll(re)) {
    const last = tokens[tokens.length - 1];
    if (m[1] !== undefined) {
      if (last && last.canon === ' ') last.raw += m[1];
      else pendingComments += m[1];
      continue;
    }
    if (m[2] !== undefined) {
      if (last && last.canon === ' ') {
        last.raw += pendingComments + m[2];
      } else {
        tokens.push({ canon: ' ', raw: pendingComments + m[2] });
      }
      pendingComments = '';
      continue;
    }
    const text = m[4] ?? m[5]!;
    tokens.push({ canon: m[4] !== undefined ? decodeEntities(m[4]) : text, raw: pendingComments + text });
    pendingComments = '';
  }
  if (pendingComments) {
    const last = tokens[tokens.length - 1];
    if (last) last.raw += pendingComments;
    else tokens.push({ canon: '', raw: pendingComments });
  }
  return tokens;
}

function tokenizeDomText(text: string): RunToken[] {
  const tokens: RunToken[] = [];
  for (const m of text.matchAll(/([ \t\n\r\f]+)|([\s\S])/gu)) {
    tokens.push(m[1] !== undefined ? { canon: ' ', raw: m[1] } : { canon: m[2]!, raw: m[2]! });
  }
  return tokens;
}

/**
 * Re-serializes a changed text run with a minimal edit: the longest unchanged prefix and suffix
 * (compared as rendered text) are kept as the original source — entities, `{' '}`, comments and
 * line/indent formatting included — and only the changed middle is written fresh (entity-encoded).
 * Comments that were inside the replaced middle are kept, right after the new text.
 */
function freshRun(domRun: Node[], sourceRun: string | null, encode: (t: string) => string): string {
  let text = '';
  for (const n of domRun) if (n.nodeName === '#text') text += (n as TextNode).value;
  if (sourceRun === null) return encode(text);
  const src = tokenizeSourceRun(sourceRun);
  const dom = tokenizeDomText(text);
  let pre = 0;
  while (pre < src.length && pre < dom.length && src[pre]!.canon === dom[pre]!.canon) pre++;
  let suf = 0;
  while (
    suf < src.length - pre &&
    suf < dom.length - pre &&
    src[src.length - 1 - suf]!.canon === dom[dom.length - 1 - suf]!.canon
  ) {
    suf++;
  }
  const keep = (toks: RunToken[]) => toks.map((t) => t.raw).join('');
  const middleSrc = src.slice(pre, src.length - suf);
  const middleComments = (keep(middleSrc).match(COMMENT) ?? []).join('');
  const middleDom = dom.slice(pre, dom.length - suf).map((t) => t.raw).join('');
  return keep(src.slice(0, pre)) + encode(middleDom) + middleComments + keep(src.slice(src.length - suf));
}

function collectOriginalStyleValues(elements: SourceElement[]): Set<string> {
  const styles = new Set<string>();
  const walk = (list: SourceElement[]) => {
    for (const el of list) {
      for (const a of el.attrs) {
        if (a.name.toLowerCase() === 'style' && (a.kind === 'quoted' || a.kind === 'empty')) {
          styles.add(a.kind === 'empty' ? '' : decodeEntities(a.value));
        }
      }
      walk(el.children);
    }
  };
  walk(elements);
  return styles;
}

function reconcileWithSource(
  domNodes: Node[],
  innerSource: string,
  tree: SourceElement[],
  options: SerializeOptions,
): SerializeResult {
  const encode = buildEntityEncoder(innerSource);
  const fresh = createFreshSerializer(options, encode, collectOriginalStyleValues(tree));
  const keepSlice = (from: number, to: number) => innerSource.slice(from, to);

  function reconcileChildren(nodes: Node[], children: SourceElement[], from: number, to: number): string {
    const dom = segmentDom(nodes);
    const gaps = sourceGaps(innerSource, children, from, to);
    const sameShape =
      dom.elements.length === children.length &&
      dom.elements.every((e, i) => e.tagName.toLowerCase() === children[i]!.tag);

    if (sameShape) {
      let out = '';
      for (let i = 0; i < gaps.length; i++) {
        const gap = gaps[i]!;
        const run = dom.runs[i]!;
        out += canonicalDomText(run) === canonicalSourceText(gap) ? gap : freshRun(run, gap, encode);
        if (i < children.length) out += reconcileElement(dom.elements[i]!, children[i]!);
      }
      return out;
    }

    // Shape changed (formatting added/removed, line breaks inserted): serialize in DOM order,
    // reusing source verbatim for elements that are unchanged and for the text run that follows
    // the last reused element when it is unchanged too.
    let out = '';
    let srcPtr = 0; // next unmatched source child
    let lastMatched = -1;
    for (let i = 0; i < dom.runs.length; i++) {
      const run = dom.runs[i]!;
      const gapAfterMatch = gaps[lastMatched + 1];
      if (gapAfterMatch !== undefined && canonicalDomText(run) === canonicalSourceText(gapAfterMatch)) {
        out += gapAfterMatch;
      } else {
        for (let k = 0; k < run.length; k++) out = fresh.serializeNodeInto(out, run[k]!, k);
      }
      if (i >= dom.elements.length) break;
      const el = dom.elements[i]!;
      const canon = canonicalDomElement(el, options);
      let matched = -1;
      for (let j = srcPtr; j < children.length; j++) {
        if (canonicalSourceElement(children[j]!, innerSource, options) === canon) {
          matched = j;
          break;
        }
      }
      if (matched >= 0) {
        const src = children[matched]!;
        out += keepSlice(src.start, src.end);
        srcPtr = matched + 1;
        lastMatched = matched;
      } else {
        out = fresh.serializeNodeInto(out, el, i + 1);
        lastMatched = Number.POSITIVE_INFINITY; // following run is new content
      }
    }
    return out;
  }

  function reconcileElement(el: Element, src: SourceElement): string {
    if (canonicalDomElement(el, options) === canonicalSourceElement(src, innerSource, options)) {
      return keepSlice(src.start, src.end);
    }
    const sameAttrs = domAttrsCanonical(el, options) === sourceAttrsCanonical(src, options);
    if (sameAttrs && src.closeStart !== null) {
      // Keep the original opening/closing tags (all attributes, `<b>` vs `<strong>`).
      return (
        keepSlice(src.start, src.openEnd) +
        reconcileChildren(el.childNodes, src.children, src.openEnd, src.closeStart) +
        keepSlice(src.closeStart, src.end)
      );
    }
    // Attributes changed (e.g. link edited): re-serialize, but keep the element's other original
    // attributes even when they are not on the passthrough whitelist.
    const keepAttrs = new Set(
      src.attrs
        .filter((a) => a.kind === 'quoted' || a.kind === 'empty')
        .map((a) => a.name.toLowerCase())
        .filter((name) => el.attrs.some((d) => d.name.toLowerCase() === name)),
    );
    return fresh.serializeNodeInto('', el, 0, keepAttrs);
  }

  const astroSource = reconcileChildren(domNodes, tree, 0, innerSource.length);
  // A kept href={url(...)} needs no new import: it compiled before, so its import exists.
  return { astroSource, needsUrlImport: fresh.needsUrlImport() };
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
    } catch (err) {
      // ENOENT: try next candidate
      ignoreMissingPath(`probing url helper ${candidate}`, err);
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
  } catch (err) {
    // Fall back to safe frontmatter fence detection below
    warnUnexpected('parsing source to place url import; using fence detection', err);
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
  /**
   * `fileHash` from inspect. When it matches the current file the patch lands at `loc`; when it
   * differs the element is relocated by `expectedContentHash` (exactly one match, else 409).
   * Omitted by old clients: loc + `expectedHash` only (previous behaviour).
   */
  expectedFileHash?: string;
  /** `contentHash` from inspect; used to relocate the element when `expectedFileHash` differs. */
  expectedContentHash?: string;
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
      /** sha256 of the file after the patch (send as the next `expectedFileHash`). */
      newFileHash: string;
      /** The element's `contentHash` after the patch (send as the next `expectedContentHash`). */
      newContentHash: string;
      /** True when the file had changed since inspect and the element was found by content. */
      relocated: boolean;
      /** Preorder locs of the edited element and its surviving descendant elements. */
      subtreeLocs?: string[];
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

/**
 * Checks a patched .astro source before it is written: it must not introduce new compiler
 * errors, and the edited element must be found again at `newLoc` with the same tag, still
 * static, and with exactly the inner content that was written.
 */
export async function verifyPatchedSource(input: {
  originalSource: string;
  patchedSource: string;
  newLoc: string;
  expectedTagName: string;
  expectedInner: string;
  /** Repo-relative path, so the returned hash is bound to the file like inspect's. */
  file?: string;
}): Promise<
  | { ok: true; inspected: NonNullable<Awaited<ReturnType<typeof inspectAstroElement>>> }
  | { ok: false; error: string }
> {
  let reInspected: Awaited<ReturnType<typeof inspectAstroElement>>;
  try {
    const [errorsBefore, errorsAfter] = await Promise.all([
      countAstroParseErrors(input.originalSource),
      countAstroParseErrors(input.patchedSource),
    ]);
    if (errorsAfter > errorsBefore) {
      return { ok: false, error: 'Edit would produce an Astro file that does not compile' };
    }
    reInspected = await inspectAstroElement(input.patchedSource, input.newLoc, { file: input.file });
  } catch (err) {
    return {
      ok: false,
      error: `Edit would produce an unparseable Astro file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (
    !reInspected ||
    reInspected.tagName !== input.expectedTagName ||
    reInspected.innerSource !== input.expectedInner ||
    reInspected.editability !== 'editable-static'
  ) {
    return { ok: false, error: 'Edit changed the page structure around the element; refusing to save' };
  }
  return { ok: true, inspected: reInspected };
}

/** write temp → fsync → rename; the temp file is removed if any step fails. */
export async function writeFileAtomic(absPath: string, contents: string | Uint8Array): Promise<void> {
  const tmpPath = `${absPath}.halley-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, 'wx');
    await (typeof contents === 'string' ? handle.writeFile(contents, 'utf8') : handle.writeFile(contents));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    if (handle) await handle.close().catch((closeErr) => console.warn('[halley-dev-edit] close failed', closeErr));
    await fs.unlink(tmpPath).catch((unlinkErr: NodeJS.ErrnoException) => {
      if (unlinkErr.code !== 'ENOENT') console.warn('[halley-dev-edit] temp cleanup failed', unlinkErr);
    });
    throw err;
  }
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
  if (path.extname(absPath).toLowerCase() !== '.astro') {
    return { ok: false, code: 400, error: 'Only .astro files can be inline-edited' };
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

    const disabledReason = await inlineEditingDisabledReason(input.repoRoot);
    const staleError = 'File changed on disk since you started editing. Please re-click to refresh.';
    const currentFileHash = sha256(source);
    const fileChanged = Boolean(input.expectedFileHash) && input.expectedFileHash !== currentFileHash;

    let loc = input.loc;
    let inspected = await inspectAstroElement(source, loc, { file: input.relFile, disabledReason });
    // Hashes from inspect callers that did not pass the file path are accepted too (same
    // element/offset/opening-tag binding, just not bound to the path).
    const locHashMatches = async () =>
      inspected?.snapshotHash === input.expectedHash ||
      (await inspectAstroElement(source, loc))?.snapshotHash === input.expectedHash;

    let relocated = false;
    if (fileChanged) {
      // The file is not the one the client inspected: loc + offset/line binding is not enough
      // (an equal-length line inserted above keeps both), so find the element by content.
      const identity =
        input.expectedContentHash ||
        (inspected?.editability === 'editable-static' && (await locHashMatches()) ? inspected.contentHash : '');
      const matches = identity ? await findElementsByContentHash(source, identity, input.relFile) : [];
      if (matches.length !== 1) {
        return {
          ok: false,
          code: 409,
          error:
            matches.length > 1
              ? 'File changed on disk and the element is no longer unique. Please re-click to refresh.'
              : staleError,
        };
      }
      const found = await inspectAstroElement(source, matches[0]!, { file: input.relFile, disabledReason });
      if (found && found.elementStartOffset !== inspected?.elementStartOffset) {
        console.info(`[halley-dev-edit] relocated stale edit in ${input.relFile}: ${loc} -> ${matches[0]}`);
        loc = matches[0]!;
        relocated = true;
      }
      inspected = found;
    }
    if (!inspected) {
      return { ok: false, code: 404, error: `Element not found at ${loc}` };
    }
    if (inspected.editability !== 'editable-static') {
      return { ok: false, code: 422, error: `Element is dynamic: ${inspected.reason}` };
    }
    if (!fileChanged && !(await locHashMatches())) {
      return { ok: false, code: 409, error: staleError };
    }

    const { astroSource, needsUrlImport } = serializeHtmlToAstro(
      input.newHtml,
      {
        previewBase: input.previewBase,
        originalBase: input.originalBase,
        hasUrlHelperFile,
      },
      inspected,
    );

    const originalInner = source.slice(inspected.innerStartOffset, inspected.innerEndOffset);
    if (astroSource === originalInner) {
      // Nothing changed in source terms: no write, no HMR churn, file stays byte-identical.
      return {
        ok: true,
        updatedSource: astroSource,
        beforeSource: source,
        afterSource: source,
        newHash: inspected.snapshotHash,
        newOuterHash: inspected.outerSnapshotHash,
        newLoc: loc,
        newFileHash: currentFileHash,
        newContentHash: inspected.contentHash ?? '',
        relocated,
        subtreeLocs: inspected.subtreeLocs,
        topLineDelta: 0,
        afterLine: countNewlines(source.slice(0, inspected.innerEndOffset)) + 1,
        afterLineDelta: 0,
        sameLineEndCol: byteColumnInLastLine(source.slice(0, inspected.innerEndOffset)),
        sameLineByteDelta: 0,
      };
    }
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

    const parsedInputLoc = parseLoc(loc);
    const newLoc = parsedInputLoc
      ? `${parsedInputLoc.line + topLineDelta}:${parsedInputLoc.column}`
      : loc;

    // Safety gate: refuse the write instead of leaving a broken page on disk.
    const verified = await verifyPatchedSource({
      originalSource: source,
      patchedSource: patched,
      newLoc,
      expectedTagName: inspected.tagName,
      expectedInner: astroSource,
      file: input.relFile,
    });
    if (!verified.ok) {
      return { ok: false, code: 422, error: verified.error };
    }
    const reInspected = verified.inspected;
    const newHash = reInspected.snapshotHash;
    const newOuterHash = reInspected.outerSnapshotHash;

    await writeFileAtomic(absPath, patched);

    return {
      ok: true,
      updatedSource: astroSource,
      beforeSource: source,
      afterSource: patched,
      newHash,
      newOuterHash,
      newLoc,
      newFileHash: sha256(patched),
      newContentHash: reInspected.contentHash ?? '',
      relocated,
      subtreeLocs: reInspected.subtreeLocs,
      topLineDelta,
      afterLine,
      afterLineDelta,
      sameLineEndCol,
      sameLineByteDelta,
    };
  });
}
