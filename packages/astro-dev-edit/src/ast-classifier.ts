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
  source: string,
  targetLine: number,
  targetCol: number,
): AstNode | null {
  for (const child of node.children ?? []) {
    const found = findElementAtLoc(child, source, targetLine, targetCol);
    if (found) return found;
  }
  if ((node.type === 'element' || node.type === 'component') && node.position) {
    const { line, column, offset } = node.position.start;
    if (line === targetLine && Math.abs(column - targetCol) <= 2) {
      return node;
    }
    // Astro 5 emits data-astro-source-loc at the closing `>` of the opening tag.
    // Check if (targetLine, targetCol) falls within the opening tag span.
    const gtOffset = findOpeningTagEndOffset(source, offset, node.position.end?.offset ?? source.length);
    if (gtOffset !== null) {
      const targetOffset = lineColToOffset(source, targetLine, targetCol);
      if (targetOffset >= offset && targetOffset <= gtOffset + 1) {
        return node;
      }
    }
  }
  return null;
}

function lineColToOffset(source: string, line: number, col: number): number {
  let curLine = 1;
  let i = 0;
  while (i < source.length && curLine < line) {
    if (source[i] === '\n') curLine++;
    i++;
  }
  return i + (col - 1);
}

function findOpeningTagEndOffset(source: string, startOffset: number, endOffset: number): number | null {
  let i = startOffset;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let braceDepth = 0;
  while (i < endOffset) {
    const ch = source[i]!;
    const prev = i > 0 ? source[i - 1] : '';
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

/**
 * Finds the offset immediately after the opening tag `>` and immediately before `</tagName>`.
 * Returns null for self-closing/void tags.
 */
function computeInnerSpan(
  source: string,
  node: AstNode,
): { innerStartOffset: number; innerEndOffset: number } | null {
  if (!node.position?.start || !node.position.end || !node.name) return null;
  const startOffset = node.position.start.offset;
  const endOffset = node.position.end.offset;
  if (endOffset <= startOffset || endOffset > source.length) return null;

  // Walk forward from startOffset to find the closing `>` of the opening tag,
  // respecting quotes and `{...}` braces.
  let i = startOffset;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let braceDepth = 0;

  while (i < endOffset) {
    const ch = source[i]!;
    const prev = i > 0 ? source[i - 1] : '';
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
      else if (ch === '>' && braceDepth === 0) {
        if (i > 0 && source[i - 1] === '/') {
          return null; // Self-closing tag
        }
        const innerStartOffset = i + 1;
        const closingTag = `</${node.name}`;
        const closingIdx = source.lastIndexOf(closingTag, endOffset);
        if (closingIdx < innerStartOffset) return null;
        return { innerStartOffset, innerEndOffset: closingIdx };
      }
    }
    i++;
  }
  return null;
}

export async function inspectAstroElement(
  source: string,
  loc: string,
): Promise<InspectResult | null> {
  const parsedLoc = parseLoc(loc);
  if (!parsedLoc) return null;

  const result = await parse(source, { position: true });
  const root = result.ast as unknown as AstNode;
  const node = findElementAtLoc(root, source, parsedLoc.line, parsedLoc.column);
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

  const span = computeInnerSpan(source, node);
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
