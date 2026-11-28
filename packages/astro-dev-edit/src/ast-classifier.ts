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
  snapshotHash: string;
  usesUrlHelper: boolean;
  outerStartOffset: number;
  outerEndOffset: number;
  openTagEndOffset: number;
  outerSource: string;
  outerSnapshotHash: string;
  context: ElementContextInfo;
  capabilities: ElementCapabilities;
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

export function findElementWithContext(
  node: AstNode,
  buf: Buffer,
  targetByteOffset: number,
  parent: AstNode | null = null,
  ancestors: AstNode[] = [],
  indexInParent = -1,
): LocatedElement | null {
  const children = node.children ?? [];
  const nextAncestors = [...ancestors, node];
  for (let i = 0; i < children.length; i++) {
    const found = findElementWithContext(
      children[i]!,
      buf,
      targetByteOffset,
      node,
      nextAncestors,
      i,
    );
    if (found) return found;
  }
  if ((node.type === 'element' || node.type === 'component') && node.position) {
    const { offset } = node.position.start;
    if (Math.abs(offset - targetByteOffset) <= 2) {
      return { node, parent, ancestors, indexInParent };
    }
    // Astro 5 emits data-astro-source-loc at the closing `>` of the opening tag.
    // Check if targetByteOffset falls within the opening tag byte span.
    const gtByteOffset = findOpeningTagEndByteOffset(
      buf,
      offset,
      node.position.end?.offset ?? buf.length,
    );
    if (gtByteOffset !== null && targetByteOffset >= offset && targetByteOffset <= gtByteOffset + 1) {
      return { node, parent, ancestors, indexInParent };
    }
  }
  return null;
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

  const prefixChars = byteOffsetToCharOffset(buf, innerStartByte);
  return {
    innerStartOffset: prefixChars,
    innerEndOffset: prefixChars + match.index,
  };
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

export async function inspectAstroElement(
  source: string,
  loc: string,
  relFile?: string,
): Promise<InspectResult | null> {
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
  const normRel = (relFile ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const isSharedFile = normRel.startsWith('src/components/') || normRel.startsWith('src/layouts/');
  const context: ElementContextInfo = { inLoopOrConditional, isSharedFile };
  const usesUrlHelper = /\bimport\s+\{[^}]*\burl\b[^}]*\}\s+from\s+['"][^'"]+['"]/.test(source);

  const outerSpan = computeOuterSpan(buf, node);
  const outerStartOffset = outerSpan?.outerStartOffset ?? 0;
  const outerEndOffset = outerSpan?.outerEndOffset ?? 0;
  const openTagEndOffset = outerSpan?.openTagEndOffset ?? 0;
  const outerSource = outerSpan ? source.slice(outerStartOffset, outerEndOffset) : '';
  const outerSnapshotHash = outerSource ? sha256(outerSource) : '';

  // Component tags (uppercase) are always dynamic/agent-edited
  if (/^[A-Z]/.test(tagName)) {
    return {
      editability: 'dynamic',
      reason: `Astro component <${tagName}>`,
      tagName,
      innerStartOffset: 0,
      innerEndOffset: 0,
      innerSource: '',
      snapshotHash: '',
      usesUrlHelper,
      outerStartOffset,
      outerEndOffset,
      openTagEndOffset,
      outerSource,
      outerSnapshotHash,
      context,
      capabilities: emptyCapabilities(`Astro component <${tagName}>`),
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
      outerStartOffset,
      outerEndOffset,
      openTagEndOffset,
      outerSource,
      outerSnapshotHash,
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

  return {
    editability: check.static ? 'editable-static' : 'dynamic',
    reason: check.reason,
    tagName,
    innerStartOffset: span.innerStartOffset,
    innerEndOffset: span.innerEndOffset,
    innerSource,
    snapshotHash: sha256(innerSource),
    usesUrlHelper,
    outerStartOffset,
    outerEndOffset,
    openTagEndOffset,
    outerSource,
    outerSnapshotHash,
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
 * Returns preorder `line:col` source locations for an element and all of its descendant HTML elements.
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
      locs.push(`${n.position.start.line}:${n.position.start.column}`);
    }
    for (const c of n.children ?? []) {
      walk(c);
    }
  };
  walk(located.node);
  return locs;
}
