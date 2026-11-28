import crypto from 'node:crypto';
import { parse } from '@astrojs/compiler';

export type EditabilityKind = 'editable-static' | 'dynamic';

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
   * sha256 of the whole file at inspect time (editable elements only). The patch endpoint
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

const ALLOWED_INLINE_TAGS = new Set([
  'strong',
  'b',
  'em',
  'i',
  'br',
  'span',
  'a',
]);

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

function isUrlHelperExpression(attr: AstAttribute): boolean {
  if (attr.kind !== 'expression') return false;
  const val = (attr.value ?? '').trim();
  return /^url\(\s*['"`][^'"`]+['"`]\s*\)$/.test(val);
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
 * Finds the element a `data-astro-source-loc` points at.
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
function findElementAtLoc(root: AstNode, buf: Buffer, targetByteOffset: number): AstNode | null {
  const exact: { inner: AstNode | null; start: AstNode | null } = { inner: null, start: null };
  const fuzzy: AstNode[] = [];
  const visit = (node: AstNode) => {
    if ((node.type === 'element' || node.type === 'component') && node.position) {
      const start = node.position.start.offset;
      const end = node.position.end?.offset ?? buf.length;
      // Only elements whose span can contain the target need the opening-tag scan.
      if (start <= targetByteOffset + 2 && targetByteOffset <= Math.max(end, start + 2)) {
        const gt = findOpeningTagEndByteOffset(buf, start, end > start ? end : buf.length);
        if (gt !== null && gt + 1 === targetByteOffset && !exact.inner) exact.inner = node;
        if (start === targetByteOffset && !exact.start) exact.start = node;
        if (
          Math.abs(start - targetByteOffset) <= 2 ||
          (gt !== null && targetByteOffset >= start && targetByteOffset <= gt + 1)
        ) {
          fuzzy.push(node);
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  if (exact.inner) return exact.inner;
  if (exact.start) return exact.start;
  return fuzzy.length === 1 ? fuzzy[0]! : null;
}

/**
 * Converts a 1-based line and 1-based UTF-8 byte column (as emitted by @astrojs/compiler)
 * into a 0-based UTF-8 byte offset.
 */
function lineByteColToByteOffset(buf: Buffer, line: number, byteCol: number): number {
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

function findOpeningTagEndByteOffset(buf: Buffer, startOffset: number, endOffset: number): number | null {
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

  const prefixChars = buf.subarray(0, innerStartByte).toString('utf8').length;
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

export async function inspectAstroElement(
  source: string,
  loc: string,
  options: InspectOptions = {},
): Promise<InspectResult | null> {
  const parsedLoc = parseLoc(loc);
  if (!parsedLoc) return null;

  const buf = Buffer.from(source, 'utf8');
  const targetByteOffset = lineByteColToByteOffset(buf, parsedLoc.line, parsedLoc.column);
  const result = await parse(source, { position: true });
  const root = result.ast as unknown as AstNode;
  const node = findElementAtLoc(root, buf, targetByteOffset);
  if (!node || !node.name) return null;

  // Component tags (uppercase) are always dynamic/agent-edited
  if (/^[A-Z]/.test(node.name)) {
    return {
      editability: 'dynamic',
      reason: `Astro component <${node.name}>`,
      tagName: node.name,
      innerStartOffset: 0,
      innerEndOffset: 0,
      innerSource: '',
      snapshotHash: '',
      usesUrlHelper: false,
    };
  }

  const directive = contentDirectiveOf(node.attributes);
  if (directive) {
    return {
      editability: 'dynamic',
      reason: `Element uses ${directive} directive`,
      tagName: node.name,
      innerStartOffset: 0,
      innerEndOffset: 0,
      innerSource: '',
      snapshotHash: '',
      usesUrlHelper: false,
    };
  }

  const span = computeInnerSpan(buf, node);
  if (!span) {
    return {
      editability: 'dynamic',
      reason: 'Void or self-closing element',
      tagName: node.name,
      innerStartOffset: 0,
      innerEndOffset: 0,
      innerSource: '',
      snapshotHash: '',
      usesUrlHelper: false,
    };
  }

  const innerSource = source.slice(span.innerStartOffset, span.innerEndOffset);
  const check: { static: boolean; reason: string } = options.disabledReason
    ? { static: false, reason: options.disabledReason }
    : areChildrenStatic(node.children ?? []);
  const usesUrlHelper = /\bimport\s+\{[^}]*\burl\b[^}]*\}\s+from\s+['"][^'"]+['"]/.test(source);

  const startByte = node.position!.start.offset;
  const elementStartOffset = buf.subarray(0, startByte).toString('utf8').length;
  const openingTagSource = buf.subarray(startByte, span.innerStartByte).toString('utf8');
  const lineStart = source.lastIndexOf('\n', elementStartOffset - 1) + 1;
  const lineContext = source.slice(lineStart, span.innerStartOffset);

  return {
    editability: check.static ? 'editable-static' : 'dynamic',
    reason: check.reason,
    tagName: node.name,
    innerStartOffset: span.innerStartOffset,
    innerEndOffset: span.innerEndOffset,
    innerSource,
    snapshotHash: computeSnapshotHash({
      file: options.file ?? '',
      tagName: node.name,
      openingTagSource,
      elementStartOffset,
      lineContext,
      innerSource,
    }),
    fileHash: sha256(source),
    contentHash: computeContentHash({
      file: options.file ?? '',
      tagName: node.name,
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
  };
}
