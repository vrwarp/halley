import crypto from 'node:crypto';
import { parse } from '@astrojs/compiler';

export type EditabilityKind = 'editable-static' | 'dynamic';

export type TextAlignValue = 'left' | 'center' | 'right';
export type ObjectPositionValue = 'top' | 'center' | 'bottom' | 'left' | 'right';
export type SpacingValue = 'tight' | 'normal' | 'spacious';

export interface ElementContextInfo {
  inLoopOrConditional: boolean;
  isSharedFile: boolean;
}

export interface LinkCapability {
  canEdit: boolean;
  href: string;
  target: string;
  isInternal: boolean;
  isUrlHelper: boolean;
}

export interface ImageCapability {
  canEditSrc: boolean;
  canEditAlt: boolean;
  src: string;
  alt: string;
  isUrlHelper: boolean;
}

export interface StyleCapability {
  canEdit: boolean;
  classes: string[];
  align: TextAlignValue | null;
  objectPosition: ObjectPositionValue | null;
  spacing: SpacingValue | null;
  supportsAlign: boolean;
  supportsFocal: boolean;
  supportsSpacing: boolean;
  reason?: string;
}

export interface StructuralCapability {
  canDuplicate: boolean;
  canDelete: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canAddAfter: boolean;
  blockReason?: string;
}

export interface ElementCapabilities {
  text: boolean;
  link: LinkCapability | null;
  image: ImageCapability | null;
  style: StyleCapability | null;
  structural: StructuralCapability;
}

export interface InspectResult {
  editability: EditabilityKind;
  reason: string;
  tagName: string;
  innerStartOffset: number;
  innerEndOffset: number;
  innerSource: string;
  /**
   * Staleness token for the patch endpoint. Covers the file path (when given), the tag, the full
   * opening-tag source, the element's absolute offset, the source line(s) from the start of the
   * element's line through its opening tag, and the inner source — so a stale loc that lands on a
   * different element with identical inner text (after lines shifted) no longer matches.
   */
  snapshotHash: string;
  /**
   * sha256 of the whole file at inspect time. The patch and mutate endpoints
   * patches at the loc only while the file is byte-identical; otherwise it relocates by
   * `contentHash`.
   */
  fileHash?: string;
  /**
   * Position-independent identity of the element (tag, opening-tag source, inner source and
   * element byte length; editable elements only). Used to relocate a patch after the file changed.
   */
  contentHash?: string;
  usesUrlHelper: boolean;
  outerStartOffset: number;
  outerEndOffset: number;
  openTagEndOffset: number;
  outerSource: string;
  /**
   * Staleness token for `/__editor/mutate`: element identity bound to the file path and the
   * element's full outer source (see `computeOuterHash`). Position-independent, so the mutate
   * endpoint pairs it with `fileHash` and relocates (exactly one match, else 409) when the file
   * changed since inspect.
   */
  outerSnapshotHash: string;
  context: ElementContextInfo;
  capabilities: ElementCapabilities;
  /**
   * Set when no direct edit of any kind (text, attributes, structure) is allowed on this element:
   * Astro component, set:html/set:text/is:raw directive, or the compat gate disabled editing.
   */
  blockedReason?: string;
  /** Char offset of the element's `<` in the source (additive; -1 when not applicable). */
  elementStartOffset?: number;
  /** Source of the element's opening tag, `<tag ...>` (additive). */
  openingTagSource?: string;
  /**
   * Inline element children of the edited element, with char offsets relative to `innerSource`
   * (additive; used by the serializer to keep unchanged source verbatim).
   */
  innerTree?: SourceElement[];
}

/** An inline element inside an editable span; offsets are chars relative to the span's inner source. */
export interface SourceElement {
  tag: string;
  /** `<` of the opening tag. */
  start: number;
  /** End of the element (after `</tag>`, or after the opening tag for void/self-closing). */
  end: number;
  /** Just after the opening tag's `>`. */
  openEnd: number;
  /** Start of `</tag>`; null for void/self-closing elements or when the closing tag is not found. */
  closeStart: number | null;
  attrs: Array<{ name: string; kind: string; value: string }>;
  children: SourceElement[];
}

export interface InspectOptions {
  /** Repo-relative file path; bound into `snapshotHash` so a hash cannot be replayed on another file. */
  file?: string;
  /**
   * When set, inline editing is disabled (e.g. unsupported Astro version): every element is
   * classified `dynamic` with this reason so edits go to the agent instead.
   */
  disabledReason?: string;
}

const VOID_TAGS = new Set(['br', 'wbr', 'img', 'hr', 'input', 'meta', 'link', 'source', 'area', 'col', 'embed', 'track']);

/**
 * Directives that make an element's rendered content differ from its source children
 * (raw HTML/text injection or raw passthrough). Inline-editing such elements would write
 * the rendered DOM back over the directive's semantics, so they are never editable.
 */
const CONTENT_DIRECTIVES = new Set(['set:html', 'set:text', 'is:raw']);

function contentDirectiveOf(attrs: AstAttribute[] | undefined): string | null {
  for (const attr of attrs ?? []) {
    const name = (attr.name ?? '').toLowerCase();
    if (CONTENT_DIRECTIVES.has(name)) return name;
  }
  return null;
}

/**
 * Number of error-severity diagnostics @astrojs/compiler reports for `source`.
 * Throws if the compiler itself fails to parse.
 */
export async function countAstroParseErrors(source: string): Promise<number> {
  const result = await parse(source, { position: true });
  return (result.diagnostics ?? []).filter((d) => d.severity === 1).length;
}

export const ALLOWED_INLINE_TAGS = new Set([
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'code',
  'small',
  'sup',
  'sub',
  'br',
  'span',
  'a',
]);

export const PROTECTED_LANDMARK_TAGS = new Set([
  'html',
  'head',
  'body',
  'main',
  'header',
  'footer',
  'nav',
  'script',
  'style',
]);

const TEXT_ALIGN_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'figcaption',
  'li',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
]);

const SPACING_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'figure',
  'ul',
  'ol',
  'li',
  'div',
  'section',
  'article',
  'aside',
  'img',
  'a',
]);

export interface AstPosition {
  start: { line: number; column: number; offset: number };
  end?: { line: number; column: number; offset: number };
}

export interface AstAttribute {
  type: 'attribute';
  name: string;
  kind: 'quoted' | 'empty' | 'expression' | 'spread' | 'shorthand' | 'template-literal';
  value: string;
  position?: AstPosition;
}

export interface AstNode {
  type: string;
  name?: string;
  value?: string;
  attributes?: AstAttribute[];
  children?: AstNode[];
  position?: AstPosition;
}

export interface LocatedElement {
  node: AstNode;
  parent: AstNode | null;
  ancestors: AstNode[];
  indexInParent: number;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function parseLoc(loc: string): { line: number; column: number } | null {
  const parts = loc.split(':');
  if (parts.length < 2) return null;
  const line = Number(parts[0]);
  const column = Number(parts[1]);
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) {
    return null;
  }
  return { line, column };
}

function isWhitespaceExpression(node: AstNode): boolean {
  if (node.type !== 'expression') return false;
  const children = node.children ?? [];
  if (children.length === 0) return true;
  return children.every(
    (c) =>
      c.type === 'text' &&
      /^['"`]\s*['"`]$/.test((c.value ?? '').trim()),
  );
}

export function extractUrlHelperPath(attr: AstAttribute): string | null {
  if (attr.kind !== 'expression') return null;
  const val = (attr.value ?? '').trim();
  const match = /^url\(\s*(['"`])([^'"`]+)\1\s*\)$/.exec(val);
  return match ? match[2]! : null;
}

function isUrlHelperExpression(attr: AstAttribute): boolean {
  return extractUrlHelperPath(attr) !== null;
}

function areChildrenStatic(nodes: AstNode[]): { static: boolean; reason: string } {
  for (const child of nodes) {
    if (child.type === 'text' || child.type === 'comment') {
      continue;
    }
    if (child.type === 'expression') {
      if (isWhitespaceExpression(child)) continue;
      return { static: false, reason: 'Contains dynamic Astro expression' };
    }
    if (child.type === 'element' && child.name) {
      const tag = child.name.toLowerCase();
      if (!ALLOWED_INLINE_TAGS.has(tag)) {
        return { static: false, reason: `Contains nested <${child.name}> element` };
      }
      const nestedDirective = contentDirectiveOf(child.attributes);
      if (nestedDirective) {
        return { static: false, reason: `Contains ${nestedDirective} directive on <${tag}>` };
      }
      for (const attr of child.attributes ?? []) {
        if (attr.kind === 'spread' || attr.kind === 'shorthand') {
          return { static: false, reason: `Contains dynamic attribute on <${tag}>` };
        }
        if (attr.kind === 'expression') {
          if (tag === 'a' && attr.name === 'href' && isUrlHelperExpression(attr)) {
            continue;
          }
          return { static: false, reason: `Contains dynamic attribute {${attr.name}} on <${tag}>` };
        }
      }
      const nested = areChildrenStatic(child.children ?? []);
      if (!nested.static) return nested;
      continue;
    }
    return { static: false, reason: `Contains ${child.type} node` };
  }
  return { static: true, reason: 'Static text and inline formatting' };
}

/**
 * Finds the element a `data-astro-source-loc` points at, with its parent/ancestor context.
 *
 * Convention (Astro 5 / @astrojs/compiler 2.x `annotateSourceFile`): the loc is the line and
 * 1-based UTF-8 byte column JUST AFTER the opening tag's `>` — i.e. the start of the element's
 * inner content. For `<p><b>x</b></p>` the `<p>` loc therefore equals the `<b>` start offset,
 * which is why a nearest-offset/children-first search picked the child. Matching order:
 *   1. exact: an element whose inner start (opening `>` + 1) equals the target (Astro 5 locs);
 *   2. exact: an element whose `<` equals the target (start-of-tag locs, used by older tooling
 *      and tests);
 *   3. fuzzy (|start - target| <= 2, or target inside the opening tag) — only when exactly one
 *      element qualifies; an ambiguous fuzzy match returns null (re-inspect / agent edit).
 */
export function findElementWithContext(
  root: AstNode,
  buf: Buffer,
  targetByteOffset: number,
): LocatedElement | null {
  let exactInner = null as LocatedElement | null;
  let exactStart = null as LocatedElement | null;
  const fuzzy: LocatedElement[] = [];
  const visit = (node: AstNode, parent: AstNode | null, ancestors: AstNode[], indexInParent: number) => {
    if ((node.type === 'element' || node.type === 'component') && node.position) {
      const start = node.position.start.offset;
      const end = node.position.end?.offset ?? buf.length;
      // Only elements starting at/before the target need the opening-tag scan. The scan is not
      // bounded by `end`: the compiler reports a bogus short end for void tags like `<img ...>`.
      const gt = start <= targetByteOffset + 2 ? findOpeningTagEndByteOffset(buf, start, buf.length) : null;
      if (gt !== null && targetByteOffset <= Math.max(end, gt + 1, start + 2)) {
        const located = (): LocatedElement => ({ node, parent, ancestors, indexInParent });
        if (gt + 1 === targetByteOffset && !exactInner) exactInner = located();
        if (start === targetByteOffset && !exactStart) exactStart = located();
        if (
          Math.abs(start - targetByteOffset) <= 2 ||
          (targetByteOffset >= start && targetByteOffset <= gt + 1)
        ) {
          fuzzy.push(located());
        }
      }
    }
    const children = node.children ?? [];
    const nextAncestors = [...ancestors, node];
    for (let i = 0; i < children.length; i++) visit(children[i]!, node, nextAncestors, i);
  };
  visit(root, null, [], -1);
  if (exactInner) return exactInner;
  if (exactStart) return exactStart;
  return fuzzy.length === 1 ? fuzzy[0]! : null;
}

/**
 * Converts a 1-based line and 1-based UTF-8 byte column (as emitted by @astrojs/compiler)
 * into a 0-based UTF-8 byte offset.
 */
export function lineByteColToByteOffset(buf: Buffer, line: number, byteCol: number): number {
  let curLine = 1;
  let i = 0;
  while (i < buf.length && curLine < line) {
    if (buf[i] === 0x0a) curLine++; // '\n'
    i++;
  }
  return Math.min(buf.length, i + Math.max(0, byteCol - 1));
}

function isByteEscaped(buf: Buffer, index: number): boolean {
  let backslashes = 0;
  let k = index - 1;
  while (k >= 0 && buf[k] === 0x5c) {
    backslashes++;
    k--;
  }
  return backslashes % 2 === 1;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findOpeningTagEndByteOffset(
  buf: Buffer,
  startOffset: number,
  endOffset: number,
): number | null {
  let i = startOffset;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let braceDepth = 0;
  const max = Math.min(endOffset, buf.length);
  while (i < max) {
    const ch = buf[i]!;
    if (inSingle) {
      if (ch === 0x27 && !isByteEscaped(buf, i)) inSingle = false; // '
    } else if (inDouble) {
      if (ch === 0x22 && !isByteEscaped(buf, i)) inDouble = false; // "
    } else if (inBacktick) {
      if (ch === 0x60 && !isByteEscaped(buf, i)) inBacktick = false; // `
    } else {
      if (ch === 0x27) inSingle = true;
      else if (ch === 0x22) inDouble = true;
      else if (ch === 0x60) inBacktick = true;
      else if (ch === 0x7b) braceDepth++; // {
      else if (ch === 0x7d && braceDepth > 0) braceDepth--; // }
      else if (ch === 0x3e && braceDepth === 0) return i; // >
    }
    i++;
  }
  return null;
}

export function byteOffsetToCharOffset(buf: Buffer, byteOffset: number): number {
  const clamped = Math.max(0, Math.min(buf.length, byteOffset));
  return buf.subarray(0, clamped).toString('utf8').length;
}

export function computeOuterSpan(
  buf: Buffer,
  node: AstNode,
): { outerStartOffset: number; outerEndOffset: number; openTagEndOffset: number } | null {
  if (!node.position?.start || !node.name) return null;
  const startByte = node.position.start.offset;
  if (startByte < 0 || startByte >= buf.length) return null;

  const searchEnd = node.position.end?.offset ?? buf.length;
  const gtByte = findOpeningTagEndByteOffset(buf, startByte, Math.max(searchEnd, buf.length));
  if (gtByte === null) return null;

  const endByte =
    node.position.end && node.position.end.offset > gtByte
      ? Math.min(node.position.end.offset, buf.length)
      : gtByte + 1;

  // Only well-formed spans are usable for structural/attribute edits: either a void or
  // self-closing tag, or an element whose span ends with its own `</tag>`. The compiler's end
  // offset for unclosed / implicitly closed elements (`<li>One<li>Two`, `<section>` closed by
  // `</div>`, `</p >`) can cut mid-tag; slicing it would corrupt the file.
  if (endByte === gtByte + 1) {
    const selfClosing = buf[gtByte - 1] === 0x2f;
    if (!selfClosing && !VOID_TAGS.has(node.name.toLowerCase())) return null;
  } else {
    const tail = buf.subarray(gtByte + 1, endByte).toString('utf8');
    if (!new RegExp(`</${escapeRegExp(node.name)}\\s*>$`, 'i').test(tail)) return null;
  }

  return {
    outerStartOffset: byteOffsetToCharOffset(buf, startByte),
    outerEndOffset: byteOffsetToCharOffset(buf, endByte),
    openTagEndOffset: byteOffsetToCharOffset(buf, gtByte + 1),
  };
}

/**
 * Finds the JS string index immediately after the opening tag `>` and immediately before `</tagName>`,
 * converting from @astrojs/compiler's UTF-8 byte offsets so multi-byte characters (em-dashes, quotes,
 * non-ASCII text) never shift spans. Returns null for self-closing/void/unclosed tags.
 */
function computeInnerSpan(
  buf: Buffer,
  node: AstNode,
): { innerStartOffset: number; innerEndOffset: number; innerStartByte: number; innerEndByte: number } | null {
  if (!node.position?.start || !node.position.end || !node.name) return null;
  const startByte = node.position.start.offset;
  const endByte = node.position.end.offset;
  if (endByte <= startByte || endByte > buf.length) return null;

  const gtByte = findOpeningTagEndByteOffset(buf, startByte, endByte);
  if (gtByte === null) return null;
  if (gtByte > 0 && buf[gtByte - 1] === 0x2f) {
    return null; // Self-closing `/>`
  }

  const innerStartByte = gtByte + 1;
  const elementUtf8 = buf.subarray(innerStartByte, endByte).toString('utf8');
  const closingTagRe = new RegExp(`</${escapeRegExp(node.name)}\\s*>$`, 'i');
  const match = closingTagRe.exec(elementUtf8);
  if (!match) return null;

  const prefixChars = byteOffsetToCharOffset(buf, innerStartByte);
  return {
    innerStartOffset: prefixChars,
    innerEndOffset: prefixChars + match.index,
    innerStartByte,
    innerEndByte: innerStartByte + Buffer.byteLength(match.input.slice(0, match.index), 'utf8'),
  };
}

/** Builds the inline element tree of an editable span (char offsets relative to `baseByte`). */
function buildSourceTree(nodes: AstNode[], buf: Buffer, baseByte: number, limitByte: number): SourceElement[] {
  const rel = (b: number) => buf.subarray(baseByte, b).toString('utf8').length;
  const out: SourceElement[] = [];
  for (const node of nodes) {
    if (node.type !== 'element' || !node.name || !node.position) continue;
    const startByte = node.position.start.offset;
    const gt = findOpeningTagEndByteOffset(buf, startByte, limitByte);
    if (gt === null) continue;
    const tag = node.name.toLowerCase();
    const attrs = (node.attributes ?? []).map((a) => ({ name: a.name, kind: a.kind, value: a.value ?? '' }));
    const selfClosing = buf[gt - 1] === 0x2f || VOID_TAGS.has(tag);
    if (selfClosing) {
      const e = rel(gt + 1);
      out.push({ tag, start: rel(startByte), end: e, openEnd: e, closeStart: null, attrs, children: [] });
      continue;
    }
    const span = computeInnerSpan(buf, node);
    const endByte = node.position.end?.offset ?? gt + 1;
    out.push({
      tag,
      start: rel(startByte),
      end: rel(Math.max(endByte, gt + 1)),
      openEnd: rel(gt + 1),
      closeStart: span ? rel(span.innerEndByte) : null,
      attrs,
      children: span ? buildSourceTree(node.children ?? [], buf, baseByte, span.innerEndByte) : [],
    });
  }
  return out;
}

/** Hash version prefix: bump when the hashed fields change so old client hashes simply 409. */
const SNAPSHOT_HASH_VERSION = 'v2';

export function computeSnapshotHash(parts: {
  file: string;
  tagName: string;
  openingTagSource: string;
  elementStartOffset: number;
  lineContext: string;
  innerSource: string;
}): string {
  return sha256(
    [
      SNAPSHOT_HASH_VERSION,
      parts.file,
      parts.tagName,
      String(parts.elementStartOffset),
      parts.openingTagSource,
      parts.lineContext,
      parts.innerSource,
    ].join('\u0000'),
  );
}

/** Version prefix of `contentHash` tokens (`c1:<tag>:<elementByteLength>:<sha256>`). */
const CONTENT_HASH_VERSION = 'c1';

/**
 * Position-independent element identity token. The tag and the element's byte length are kept
 * in clear so relocation can skip non-candidates without slicing/hashing them.
 */
export function computeContentHash(parts: {
  file: string;
  tagName: string;
  openingTagSource: string;
  innerSource: string;
  elementByteLength: number;
}): string {
  const digest = sha256(
    [CONTENT_HASH_VERSION, parts.file, parts.tagName, parts.openingTagSource, parts.innerSource].join('\u0000'),
  );
  return `${CONTENT_HASH_VERSION}:${parts.tagName}:${parts.elementByteLength}:${digest}`;
}

/** 1-based `line:byteCol` of a 0-based UTF-8 byte offset. */
function byteOffsetToLoc(buf: Buffer, byteOffset: number): string {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < byteOffset; i++) {
    if (buf[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return `${line}:${byteOffset - lineStart + 1}`;
}

/**
 * Locs (Astro 5 convention: just after the opening tag's `>`) of every element whose
 * `contentHash` equals `contentHash`, bound to `file` or unbound (callers that inspected
 * without a file path). Parses the source once.
 */
export async function findElementsByContentHash(
  source: string,
  contentHash: string,
  file = '',
): Promise<string[]> {
  const m = /^c1:([^:]+):(\d+):[0-9a-f]{64}$/.exec(contentHash);
  if (!m) return [];
  const tagName = m[1]!;
  const elementByteLength = Number(m[2]);
  const buf = Buffer.from(source, 'utf8');
  const result = await parse(source, { position: true });
  const locs: string[] = [];
  const visit = (node: AstNode) => {
    if (
      node.type === 'element' &&
      node.name === tagName &&
      node.position?.end &&
      node.position.end.offset - node.position.start.offset === elementByteLength
    ) {
      const span = computeInnerSpan(buf, node);
      if (span) {
        const openingTagSource = buf.subarray(node.position.start.offset, span.innerStartByte).toString('utf8');
        const innerSource = source.slice(span.innerStartOffset, span.innerEndOffset);
        const parts = { tagName, openingTagSource, innerSource, elementByteLength };
        if (
          computeContentHash({ ...parts, file }) === contentHash ||
          (file !== '' && computeContentHash({ ...parts, file: '' }) === contentHash)
        ) {
          locs.push(byteOffsetToLoc(buf, span.innerStartByte));
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(result.ast as unknown as AstNode);
  return locs;
}

function countTagInAst(node: AstNode, tagNameLower: string): number {
  let count = 0;
  if (node.type === 'element' && node.name?.toLowerCase() === tagNameLower) {
    count += 1;
  }
  for (const child of node.children ?? []) {
    count += countTagInAst(child, tagNameLower);
  }
  return count;
}

function isIgnorableSibling(node: AstNode): boolean {
  if (node.type === 'comment') return true;
  if (node.type === 'text' && !(node.value ?? '').trim()) return true;
  return false;
}

export function findAdjacentStaticSiblingNode(
  located: LocatedElement,
  buf: Buffer,
  direction: 'up' | 'down',
): AstNode | null {
  const { parent, indexInParent } = located;
  if (!parent || indexInParent < 0) return null;
  const siblings = parent.children ?? [];
  const step = direction === 'up' ? -1 : 1;
  for (let i = indexInParent + step; i >= 0 && i < siblings.length; i += step) {
    const sib = siblings[i]!;
    if (isIgnorableSibling(sib)) continue;
    if (
      sib.type === 'element' &&
      sib.name &&
      !/^[A-Z]/.test(sib.name) &&
      !PROTECTED_LANDMARK_TAGS.has(sib.name.toLowerCase()) &&
      computeOuterSpan(buf, sib) !== null
    ) {
      return sib;
    }
    return null;
  }
  return null;
}

function analyzeLinkCapability(node: AstNode): LinkCapability | null {
  if (node.name?.toLowerCase() !== 'a') return null;
  const attrs = node.attributes ?? [];
  const hrefAttr = attrs.find((a) => a.name.toLowerCase() === 'href');
  const targetAttr = attrs.find((a) => a.name.toLowerCase() === 'target');
  const target = targetAttr && targetAttr.kind === 'quoted' ? targetAttr.value : '';

  if (!hrefAttr) {
    return { canEdit: true, href: '', target, isInternal: false, isUrlHelper: false };
  }
  if (hrefAttr.kind === 'quoted') {
    const val = hrefAttr.value;
    return {
      canEdit: true,
      href: val,
      target,
      isInternal: val.startsWith('/') && !val.startsWith('//'),
      isUrlHelper: false,
    };
  }
  const urlPath = extractUrlHelperPath(hrefAttr);
  if (urlPath !== null) {
    return {
      canEdit: true,
      href: urlPath,
      target,
      isInternal: true,
      isUrlHelper: true,
    };
  }
  return { canEdit: false, href: '', target, isInternal: false, isUrlHelper: false };
}

function analyzeImageCapability(node: AstNode): ImageCapability | null {
  if (node.name?.toLowerCase() !== 'img') return null;
  const attrs = node.attributes ?? [];
  const srcAttr = attrs.find((a) => a.name.toLowerCase() === 'src');
  const altAttr = attrs.find((a) => a.name.toLowerCase() === 'alt');

  let canEditSrc = false;
  let src = '';
  let isUrlHelper = false;
  if (!srcAttr) {
    canEditSrc = true;
  } else if (srcAttr.kind === 'quoted') {
    canEditSrc = true;
    src = srcAttr.value;
  } else {
    const urlPath = extractUrlHelperPath(srcAttr);
    if (urlPath !== null) {
      canEditSrc = true;
      src = urlPath;
      isUrlHelper = true;
    }
  }

  let canEditAlt = false;
  let alt = '';
  if (!altAttr) {
    canEditAlt = true;
  } else if (altAttr.kind === 'quoted' || altAttr.kind === 'empty') {
    canEditAlt = true;
    alt = altAttr.value ?? '';
  }

  return { canEditSrc, canEditAlt, src, alt, isUrlHelper };
}

function analyzeStyleCapability(node: AstNode): StyleCapability | null {
  const tag = node.name?.toLowerCase() ?? '';
  if (!tag || /^[A-Z]/.test(node.name ?? '') || PROTECTED_LANDMARK_TAGS.has(tag)) {
    return null;
  }
  const attrs = node.attributes ?? [];
  const hasClassList = attrs.some((a) => a.name.toLowerCase() === 'class:list');
  const hasSpread = attrs.some((a) => a.kind === 'spread');
  const classAttr = attrs.find((a) => a.name.toLowerCase() === 'class');

  const supportsAlign = TEXT_ALIGN_TAGS.has(tag);
  const supportsFocal = tag === 'img';
  const supportsSpacing = SPACING_TAGS.has(tag);
  if (!supportsAlign && !supportsFocal && !supportsSpacing) {
    return null;
  }

  if (hasClassList || hasSpread || (classAttr && classAttr.kind !== 'quoted' && classAttr.kind !== 'empty')) {
    return {
      canEdit: false,
      classes: [],
      align: null,
      objectPosition: null,
      spacing: null,
      supportsAlign,
      supportsFocal,
      supportsSpacing,
      reason: 'Dynamic classes — Ask Halley to restyle',
    };
  }

  const classes = (classAttr?.value ?? '').split(/\s+/).filter(Boolean);

  let align: TextAlignValue | null = null;
  if (classes.includes('text-left')) align = 'left';
  else if (classes.includes('text-center')) align = 'center';
  else if (classes.includes('text-right')) align = 'right';

  let objectPosition: ObjectPositionValue | null = null;
  if (classes.includes('object-top')) objectPosition = 'top';
  else if (classes.includes('object-center')) objectPosition = 'center';
  else if (classes.includes('object-bottom')) objectPosition = 'bottom';
  else if (classes.includes('object-left')) objectPosition = 'left';
  else if (classes.includes('object-right')) objectPosition = 'right';

  let spacing: SpacingValue | null = null;
  if (classes.includes('my-2')) spacing = 'tight';
  else if (classes.includes('my-6')) spacing = 'normal';
  else if (classes.includes('my-12')) spacing = 'spacious';

  return {
    canEdit: true,
    classes,
    align,
    objectPosition,
    spacing,
    supportsAlign,
    supportsFocal,
    supportsSpacing,
  };
}

function analyzeStructuralCapability(
  root: AstNode,
  located: LocatedElement,
  buf: Buffer,
  inLoopOrConditional: boolean,
): StructuralCapability {
  const tag = located.node.name?.toLowerCase() ?? '';
  if (!tag || /^[A-Z]/.test(located.node.name ?? '')) {
    return {
      canDuplicate: false,
      canDelete: false,
      canMoveUp: false,
      canMoveDown: false,
      canAddAfter: false,
      blockReason: 'Astro component — Ask Halley for structural edits',
    };
  }
  if (inLoopOrConditional) {
    return {
      canDuplicate: false,
      canDelete: false,
      canMoveUp: false,
      canMoveDown: false,
      canAddAfter: false,
      blockReason: 'Inside loop or conditional — Ask Halley to add, reorder, or remove items',
    };
  }
  if (PROTECTED_LANDMARK_TAGS.has(tag)) {
    return {
      canDuplicate: false,
      canDelete: false,
      canMoveUp: false,
      canMoveDown: false,
      canAddAfter: false,
      blockReason: `Protected layout element <${tag}>`,
    };
  }
  if (!located.parent || located.parent.type === 'root') {
    return {
      canDuplicate: false,
      canDelete: false,
      canMoveUp: false,
      canMoveDown: false,
      canAddAfter: false,
      blockReason: 'Top-level page element',
    };
  }

  let canDelete = true;
  let blockReason: string | undefined;
  if (tag === 'h1' && countTagInAst(root, 'h1') <= 1) {
    canDelete = false;
    blockReason = 'Cannot delete the sole page heading (<h1>)';
  }

  const canMoveUp = findAdjacentStaticSiblingNode(located, buf, 'up') !== null;
  const canMoveDown = findAdjacentStaticSiblingNode(located, buf, 'down') !== null;

  return {
    canDuplicate: true,
    canDelete,
    canMoveUp,
    canMoveDown,
    canAddAfter: true,
    blockReason,
  };
}

function emptyCapabilities(reason?: string): ElementCapabilities {
  return {
    text: false,
    link: null,
    image: null,
    style: null,
    structural: {
      canDuplicate: false,
      canDelete: false,
      canMoveUp: false,
      canMoveDown: false,
      canAddAfter: false,
      blockReason: reason,
    },
  };
}

/** Version prefix of `outerSnapshotHash` tokens; bump when the hashed fields change. */
const OUTER_HASH_VERSION = 'o1';

/** Element identity for structural/attribute mutations: file path + full outer source. */
export function computeOuterHash(parts: { file: string; outerSource: string }): string {
  return sha256([OUTER_HASH_VERSION, parts.file, parts.outerSource].join('\u0000'));
}

/**
 * Astro 5 `line:byteCol` loc of an element: just after its opening tag's `>` (the convention
 * `data-astro-source-loc` uses), so locs returned after a mutation match what a page reload
 * would emit. Null when the opening tag cannot be scanned.
 */
function elementLoc(buf: Buffer, node: AstNode): string | null {
  if (!node.position) return null;
  const gt = findOpeningTagEndByteOffset(buf, node.position.start.offset, buf.length);
  return gt === null ? null : byteOffsetToLoc(buf, gt + 1);
}

/** Astro 5 loc (see `elementLoc`) of the element whose `<` is at char offset `charOffset`. */
export function locForElementStartingAt(source: string, charOffset: number): string | null {
  const buf = Buffer.from(source, 'utf8');
  const startByte = Buffer.byteLength(source.slice(0, charOffset), 'utf8');
  const gt = findOpeningTagEndByteOffset(buf, startByte, buf.length);
  return gt === null ? null : byteOffsetToLoc(buf, gt + 1);
}

/**
 * Locs (Astro 5 convention) of every HTML element whose `computeOuterHash` for `file` equals
 * `outerHash`. Used to relocate a mutation after the file changed since inspect.
 */
export async function findElementsByOuterHash(source: string, outerHash: string, file = ''): Promise<string[]> {
  if (!/^[0-9a-f]{64}$/.test(outerHash)) return [];
  const buf = Buffer.from(source, 'utf8');
  const result = await parse(source, { position: true });
  const locs: string[] = [];
  const visit = (node: AstNode) => {
    if (node.type === 'element' && node.name && node.position) {
      const span = computeOuterSpan(buf, node);
      if (span) {
        const outerSource = source.slice(span.outerStartOffset, span.outerEndOffset);
        if (computeOuterHash({ file, outerSource }) === outerHash) {
          const loc = elementLoc(buf, node);
          if (loc) locs.push(loc);
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(result.ast as unknown as AstNode);
  return locs;
}

/**
 * Number of element/component nodes whose source span is not well formed (see
 * `computeOuterSpan`: unclosed, implicitly closed, or closed by another tag's `</...>`). The
 * compiler accepts these without diagnostics, so a mutation must never increase this count.
 */
export function countMalformedElements(source: string, root: AstNode): number {
  const buf = Buffer.from(source, 'utf8');
  let n = 0;
  const visit = (node: AstNode) => {
    if ((node.type === 'element' || node.type === 'component') && node.name && node.position) {
      if (computeOuterSpan(buf, node) === null) n++;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return n;
}

/** Number of element/component nodes in a parsed Astro tree (structural sanity check). */
export function countElementNodes(node: AstNode): number {
  let n = node.type === 'element' || node.type === 'component' ? 1 : 0;
  for (const child of node.children ?? []) n += countElementNodes(child);
  return n;
}

export async function inspectAstroElement(
  source: string,
  loc: string,
  /** Inspect options, or (legacy call shape) the repo-relative file path. */
  optionsOrFile: InspectOptions | string = {},
): Promise<InspectResult | null> {
  const options: InspectOptions = typeof optionsOrFile === 'string' ? { file: optionsOrFile } : optionsOrFile;
  const relFile = options.file ?? '';
  const parsedLoc = parseLoc(loc);
  if (!parsedLoc) return null;

  const buf = Buffer.from(source, 'utf8');
  const targetByteOffset = lineByteColToByteOffset(buf, parsedLoc.line, parsedLoc.column);
  const result = await parse(source, { position: true });
  const root = result.ast as unknown as AstNode;
  const located = findElementWithContext(root, buf, targetByteOffset);
  if (!located || !located.node.name) return null;

  const { node, ancestors } = located;
  const tagName = located.node.name;
  const inLoopOrConditional = ancestors.some((a) => a.type === 'expression');
  const normRel = relFile.replace(/\\/g, '/').replace(/^\/+/, '');
  const isSharedFile = normRel.startsWith('src/components/') || normRel.startsWith('src/layouts/');
  const context: ElementContextInfo = { inLoopOrConditional, isSharedFile };
  const usesUrlHelper = /\bimport\s+\{[^}]*\burl\b[^}]*\}\s+from\s+['"][^'"]+['"]/.test(source);
  const fileHash = sha256(source);

  const outerSpan = computeOuterSpan(buf, node);
  const outerStartOffset = outerSpan?.outerStartOffset ?? 0;
  const outerEndOffset = outerSpan?.outerEndOffset ?? 0;
  const openTagEndOffset = outerSpan?.openTagEndOffset ?? 0;
  const outerSource = outerSpan ? source.slice(outerStartOffset, outerEndOffset) : '';
  const outerSnapshotHash = outerSource ? computeOuterHash({ file: relFile, outerSource }) : '';
  const outer = { outerStartOffset, outerEndOffset, openTagEndOffset, outerSource, outerSnapshotHash, fileHash };

  const notEditable = (reason: string): InspectResult => ({
    editability: 'dynamic',
    reason,
    tagName,
    innerStartOffset: 0,
    innerEndOffset: 0,
    innerSource: '',
    snapshotHash: '',
    usesUrlHelper,
    ...outer,
    context,
    capabilities: emptyCapabilities(reason),
    blockedReason: reason,
  });

  // Component tags (uppercase) are always dynamic/agent-edited
  if (/^[A-Z]/.test(tagName)) return notEditable(`Astro component <${tagName}>`);

  // Raw HTML/text injection: neither text, attributes nor structure are edited directly.
  const directive = contentDirectiveOf(node.attributes);
  if (directive) return notEditable(`Element uses ${directive} directive`);

  // Unsupported Astro/compiler version (compat gate): every direct edit goes to the agent.
  if (options.disabledReason) {
    const span = computeInnerSpan(buf, node);
    return {
      ...notEditable(options.disabledReason),
      ...(span
        ? {
            innerStartOffset: span.innerStartOffset,
            innerEndOffset: span.innerEndOffset,
            innerSource: source.slice(span.innerStartOffset, span.innerEndOffset),
          }
        : {}),
    };
  }

  const linkCap = analyzeLinkCapability(node);
  const imageCap = analyzeImageCapability(node);
  const styleCap = analyzeStyleCapability(node);
  const structuralCap = outerSpan
    ? analyzeStructuralCapability(root, located, buf, inLoopOrConditional)
    : emptyCapabilities('Unmapped element span').structural;

  const span = computeInnerSpan(buf, node);
  if (!span) {
    return {
      editability: 'dynamic',
      reason: 'Void or self-closing element',
      tagName,
      innerStartOffset: 0,
      innerEndOffset: 0,
      innerSource: '',
      snapshotHash: outerSnapshotHash,
      usesUrlHelper,
      ...outer,
      context,
      capabilities: {
        text: false,
        link: linkCap,
        image: imageCap,
        style: styleCap,
        structural: structuralCap,
      },
    };
  }

  const innerSource = source.slice(span.innerStartOffset, span.innerEndOffset);
  const check = areChildrenStatic(node.children ?? []);

  const startByte = node.position!.start.offset;
  const elementStartOffset = buf.subarray(0, startByte).toString('utf8').length;
  const openingTagSource = buf.subarray(startByte, span.innerStartByte).toString('utf8');
  const lineStart = source.lastIndexOf('\n', elementStartOffset - 1) + 1;
  const lineContext = source.slice(lineStart, span.innerStartOffset);

  return {
    editability: check.static ? 'editable-static' : 'dynamic',
    reason: check.reason,
    tagName,
    innerStartOffset: span.innerStartOffset,
    innerEndOffset: span.innerEndOffset,
    innerSource,
    snapshotHash: computeSnapshotHash({
      file: relFile,
      tagName,
      openingTagSource,
      elementStartOffset,
      lineContext,
      innerSource,
    }),
    contentHash: computeContentHash({
      file: relFile,
      tagName,
      openingTagSource,
      innerSource,
      elementByteLength: (node.position!.end?.offset ?? startByte) - startByte,
    }),
    usesUrlHelper,
    elementStartOffset,
    openingTagSource,
    innerTree: check.static
      ? buildSourceTree(node.children ?? [], buf, span.innerStartByte, span.innerEndByte)
      : undefined,
    ...outer,
    context,
    capabilities: {
      text: check.static,
      link: linkCap,
      image: imageCap,
      style: styleCap,
      structural: structuralCap,
    },
  };
}

/**
 * Returns preorder source locations (Astro 5 convention: just after each opening tag's `>`,
 * matching `data-astro-source-loc`) for an element and all of its descendant HTML elements.
 * Used after structural mutations (duplicate, move, add-block) so the client can remap every
 * cloned/moved DOM node's `data-astro-source-loc` accurately without reloading the page.
 */
export async function collectSubtreeLocs(source: string, rootLoc: string): Promise<string[]> {
  const parsedLoc = parseLoc(rootLoc);
  if (!parsedLoc) return [];
  const buf = Buffer.from(source, 'utf8');
  const targetByteOffset = lineByteColToByteOffset(buf, parsedLoc.line, parsedLoc.column);
  const result = await parse(source, { position: true });
  const root = result.ast as unknown as AstNode;
  const located = findElementWithContext(root, buf, targetByteOffset);
  if (!located) return [];

  const locs: string[] = [];
  const walk = (n: AstNode) => {
    if (n.type === 'element' && n.position?.start) {
      const loc = elementLoc(buf, n);
      if (loc) locs.push(loc);
    }
    for (const c of n.children ?? []) {
      walk(c);
    }
  };
  walk(located.node);
  return locs;
}
