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
  snapshotHash: string;
  usesUrlHelper: boolean;
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

function findElementAtLoc(
  node: AstNode,
  buf: Buffer,
  targetByteOffset: number,
): AstNode | null {
  for (const child of node.children ?? []) {
    const found = findElementAtLoc(child, buf, targetByteOffset);
    if (found) return found;
  }
  if ((node.type === 'element' || node.type === 'component') && node.position) {
    const { offset } = node.position.start;
    if (Math.abs(offset - targetByteOffset) <= 2) {
      return node;
    }
    // Astro 5 emits data-astro-source-loc at the closing `>` of the opening tag.
    // Check if targetByteOffset falls within the opening tag byte span.
    const gtByteOffset = findOpeningTagEndByteOffset(
      buf,
      offset,
      node.position.end?.offset ?? buf.length,
    );
    if (gtByteOffset !== null && targetByteOffset >= offset && targetByteOffset <= gtByteOffset + 1) {
      return node;
    }
  }
  return null;
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
): { innerStartOffset: number; innerEndOffset: number } | null {
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
  };
}

export async function inspectAstroElement(
  source: string,
  loc: string,
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
  const check = areChildrenStatic(node.children ?? []);
  const usesUrlHelper = /\bimport\s+\{[^}]*\burl\b[^}]*\}\s+from\s+['"][^'"]+['"]/.test(source);

  return {
    editability: check.static ? 'editable-static' : 'dynamic',
    reason: check.reason,
    tagName: node.name,
    innerStartOffset: span.innerStartOffset,
    innerEndOffset: span.innerEndOffset,
    innerSource,
    snapshotHash: sha256(innerSource),
    usesUrlHelper,
  };
}
