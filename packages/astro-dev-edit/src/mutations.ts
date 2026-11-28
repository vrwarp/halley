import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@astrojs/compiler';
import {
  byteOffsetToCharOffset,
  collectSubtreeLocs,
  computeOuterSpan,
  countAstroParseErrors,
  countElementNodes,
  countMalformedElements,
  findAdjacentStaticSiblingNode,
  findElementsByOuterHash,
  findElementWithContext,
  inspectAstroElement,
  lineByteColToByteOffset,
  locForElementStartingAt,
  parseLoc,
  sha256,
  type AstNode,
  type InspectResult,
  type ObjectPositionValue,
  type SpacingValue,
  type TextAlignValue,
} from './ast-classifier.js';
import { inlineEditingDisabledReason } from './compat.js';
import type { AsyncFileLock } from './file-lock.js';
import {
  byteColumnInLastLine,
  countNewlines,
  escapeAttr,
  injectUrlImportIfMissing,
  normalizeHref,
  resolveUrlHelperAbs,
  writeFileAtomic,
} from './serializer.js';

export type AddBlockKind = 'paragraph' | 'heading' | 'list-item' | 'image';

export type ElementMutation =
  | {
      kind: 'set-link';
      href: string;
      openInNewTab?: boolean;
    }
  | {
      kind: 'set-image';
      src?: string;
      alt?: string;
    }
  | {
      kind: 'set-style';
      align?: TextAlignValue | null;
      objectPosition?: ObjectPositionValue | null;
      spacing?: SpacingValue | null;
    }
  | {
      kind: 'duplicate';
    }
  | {
      kind: 'delete';
    }
  | {
      kind: 'move';
      direction: 'up' | 'down';
    }
  | {
      kind: 'add-block';
      blockKind: AddBlockKind;
      imageSrc?: string;
      imageAlt?: string;
    };

export interface MutateElementInput {
  repoRoot: string;
  relFile: string;
  loc: string;
  expectedOuterHash: string;
  /**
   * `fileHash` from inspect. When it matches the current file the mutation lands at `loc`;
   * when it differs the element is relocated by `expectedOuterHash` (exactly one match, else
   * 409). Omitted by old clients: loc + `expectedOuterHash` only.
   */
  expectedFileHash?: string;
  mutation: ElementMutation;
  previewBase: string;
  originalBase: string;
  fileLock: AsyncFileLock;
}

export type MutateElementResult =
  | {
      ok: true;
      kind: ElementMutation['kind'];
      summary: string;
      beforeSource: string;
      afterSource: string;
      newLoc: string;
      newHash: string;
      newOuterHash: string;
      /** sha256 of the file after the mutation (send as the next `fileHash`). */
      newFileHash: string;
      /** True when the file had changed since inspect and the element was found by content. */
      relocated: boolean;
      topLineDelta: number;
      afterLine: number;
      afterLineDelta: number;
      sameLineEndCol: number;
      sameLineByteDelta: number;
      /** Preorder locs of the newly created/duplicated/moved element subtree. */
      subtreeLocs?: string[];
      /** Preorder locs of the sibling element swapped during a `move` mutation. */
      swappedSubtreeLocs?: string[];
      /** Applied class string for `set-style` so the client updates className optimistically. */
      appliedClass?: string;
      /** Applied HTML snippet for `add-block` so the client inserts the element optimistically. */
      insertedHtml?: string;
      /** Applied preview-resolved href/src for optimistic DOM sync. */
      resolvedHref?: string;
      resolvedSrc?: string;
      appliedTarget?: string;
      appliedRel?: string;
      appliedAlt?: string;
    }
  | { ok: false; code: 400 | 404 | 409 | 422; error: string };

interface ScannedAttr {
  name: string;
  lowerName: string;
  wsStart: number;
  start: number;
  end: number;
}

function scanOpeningTagAttributes(openTag: string): {
  attrs: ScannedAttr[];
  insertOffset: number;
} {
  // Skip `<tagName`
  let i = 1;
  while (i < openTag.length && !/[\s/>]/.test(openTag[i]!)) i++;

  const attrs: ScannedAttr[] = [];
  const len = openTag.length;

  // Closing boundary is `/>` or `>`
  const isSelfClosing = openTag.endsWith('/>');
  const closeStart = isSelfClosing ? len - 2 : len - 1;

  while (i < closeStart) {
    const wsStart = i;
    while (i < closeStart && /\s/.test(openTag[i]!)) i++;
    if (i >= closeStart) break;

    const attrStart = i;
    // Spread attribute `{...props}`
    if (openTag[i] === '{') {
      let depth = 1;
      i++;
      let inS = false;
      let inD = false;
      let inB = false;
      while (i < closeStart && depth > 0) {
        const ch = openTag[i]!;
        if (inS) {
          if (ch === "'" && openTag[i - 1] !== '\\') inS = false;
        } else if (inD) {
          if (ch === '"' && openTag[i - 1] !== '\\') inD = false;
        } else if (inB) {
          if (ch === '`' && openTag[i - 1] !== '\\') inB = false;
        } else {
          if (ch === "'") inS = true;
          else if (ch === '"') inD = true;
          else if (ch === '`') inB = true;
          else if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        i++;
      }
      continue;
    }

    // Read attribute name
    while (i < closeStart && !/[\s=/>]/.test(openTag[i]!)) i++;
    const name = openTag.slice(attrStart, i);
    if (!name) {
      i++;
      continue;
    }

    // Optional `= value`
    let afterName = i;
    while (afterName < closeStart && /\s/.test(openTag[afterName]!)) afterName++;
    if (afterName < closeStart && openTag[afterName] === '=') {
      i = afterName + 1;
      while (i < closeStart && /\s/.test(openTag[i]!)) i++;
      if (i < closeStart) {
        const quote = openTag[i]!;
        if (quote === '"' || quote === "'") {
          i++;
          while (i < closeStart && openTag[i] !== quote) {
            if (openTag[i] === '\\') i++;
            i++;
          }
          if (i < closeStart) i++;
        } else if (quote === '{') {
          let depth = 1;
          i++;
          let inS = false;
          let inD = false;
          let inB = false;
          while (i < closeStart && depth > 0) {
            const ch = openTag[i]!;
            if (inS) {
              if (ch === "'" && openTag[i - 1] !== '\\') inS = false;
            } else if (inD) {
              if (ch === '"' && openTag[i - 1] !== '\\') inD = false;
            } else if (inB) {
              if (ch === '`' && openTag[i - 1] !== '\\') inB = false;
            } else {
              if (ch === "'") inS = true;
              else if (ch === '"') inD = true;
              else if (ch === '`') inB = true;
              else if (ch === '{') depth++;
              else if (ch === '}') depth--;
            }
            i++;
          }
        } else {
          while (i < closeStart && !/[\s/>]/.test(openTag[i]!)) i++;
        }
      }
    }

    attrs.push({
      name,
      lowerName: name.toLowerCase(),
      wsStart,
      start: attrStart,
      end: i,
    });
  }

  // Insert before trailing whitespace + `/>` or `>`
  let insertOffset = closeStart;
  while (insertOffset > 1 && /[ \t]/.test(openTag[insertOffset - 1]!)) {
    insertOffset--;
  }
  return { attrs, insertOffset };
}

/**
 * Rewrites attributes inside a single opening HTML/Astro tag (`<tag ...>` or `<tag ... />`).
 * Map keys are lowercase attribute names; values are full rendered attribute strings (e.g. `alt="Hi"`
 * or `href={url('/about')}`), or `null` to delete the attribute.
 */
export function rewriteOpeningTagAttrs(
  openTag: string,
  updates: Record<string, string | null>,
): string {
  const { attrs, insertOffset } = scanOpeningTagAttributes(openTag);
  const handled = new Set<string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];

  for (const attr of attrs) {
    if (Object.prototype.hasOwnProperty.call(updates, attr.lowerName)) {
      handled.add(attr.lowerName);
      const next = updates[attr.lowerName];
      if (next === null) {
        edits.push({ start: attr.wsStart, end: attr.end, text: '' });
      } else if (typeof next === 'string') {
        edits.push({ start: attr.start, end: attr.end, text: next });
      }
    }
  }

  const additions: string[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (!handled.has(key) && typeof val === 'string') {
      additions.push(val);
    }
  }
  if (additions.length > 0) {
    edits.push({ start: insertOffset, end: insertOffset, text: ` ${additions.join(' ')}` });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = openTag;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** Strips static `id="..."` / `id='...'` attributes from opening tags in an HTML/Astro snippet. */
function stripStaticIds(snippet: string): string {
  return snippet.replace(/(<[a-zA-Z][a-zA-Z0-9:-]*\b[^>]*?>)/g, (tag) => {
    return rewriteOpeningTagAttrs(tag, { id: null });
  });
}

function getLineIndentAt(source: string, charOffset: number): string {
  const lineStart = source.lastIndexOf('\n', Math.max(0, charOffset - 1)) + 1;
  const prefix = source.slice(lineStart, charOffset);
  const m = /^([ \t]*)/.exec(prefix);
  return m ? m[1]! : '';
}

const ALIGN_CLASSES = new Set(['text-left', 'text-center', 'text-right']);
const OBJECT_POS_RE = /^object-(?:top|center|bottom|left|right|left-top|left-bottom|right-top|right-bottom|\[[^\]]+\])$/;
const SPACING_CLASSES = new Set(['my-2', 'my-4', 'my-6', 'my-8', 'my-10', 'my-12']);

const SPACING_MAP: Record<SpacingValue, string> = {
  tight: 'my-2',
  normal: 'my-6',
  spacious: 'my-12',
};

export function applyTailwindStylePresets(
  existingClasses: string[],
  opts: {
    align?: TextAlignValue | null;
    objectPosition?: ObjectPositionValue | null;
    spacing?: SpacingValue | null;
  },
): string[] {
  let next = [...existingClasses];

  if (opts.align !== undefined) {
    next = next.filter((c) => !ALIGN_CLASSES.has(c));
    if (opts.align !== null) {
      next.push(`text-${opts.align}`);
    }
  }

  if (opts.objectPosition !== undefined) {
    next = next.filter((c) => !OBJECT_POS_RE.test(c));
    if (opts.objectPosition !== null) {
      next.push(`object-${opts.objectPosition}`);
    }
  }

  if (opts.spacing !== undefined) {
    next = next.filter((c) => !SPACING_CLASSES.has(c));
    if (opts.spacing !== null) {
      next.push(SPACING_MAP[opts.spacing]);
    }
  }

  return next;
}

function findMatchingTagClassInNode(node: AstNode, tagLower: string): string | null {
  for (const child of node.children ?? []) {
    if (child.type === 'element' && child.name?.toLowerCase() === tagLower) {
      const cls = child.attributes?.find(
        (a) => a.name.toLowerCase() === 'class' && a.kind === 'quoted' && a.value.trim(),
      );
      if (cls) return cls.value.trim();
    }
  }
  return null;
}

function findMatchingTagClassRecursive(node: AstNode, tagLower: string): string | null {
  if (node.type === 'element' && node.name?.toLowerCase() === tagLower) {
    const cls = node.attributes?.find(
      (a) => a.name.toLowerCase() === 'class' && a.kind === 'quoted' && a.value.trim(),
    );
    if (cls) return cls.value.trim();
  }
  for (const child of node.children ?? []) {
    const found = findMatchingTagClassRecursive(child, tagLower);
    if (found) return found;
  }
  return null;
}

const DEFAULT_BLOCK_CLASSES: Record<AddBlockKind, string> = {
  paragraph: 'mt-4 text-base leading-relaxed',
  heading: 'mt-8 text-2xl font-semibold tracking-tight',
  'list-item': '',
  image: 'mt-6 w-full rounded-xl object-cover',
};

function resolvePreviewUrl(publicPath: string, previewBase: string): string {
  if (!publicPath.startsWith('/') || publicPath.startsWith('//')) return publicPath;
  const cleanBase = previewBase === '/' ? '' : previewBase.replace(/\/$/, '');
  return `${cleanBase}${publicPath}`;
}

/** What a mutated file must look like before it is written (see `verifyMutatedSource`). */
export interface MutationExpectation {
  /** Net change in the number of element/component nodes (e.g. +1 for add-block). */
  elementDelta: number;
  /** Loc (Astro 5 convention) of the element the mutation produced/kept; null for delete. */
  loc: string | null;
  tagName?: string;
  /** Exact outer source the element at `loc` must have after the mutation. */
  outerSource?: string;
}

/**
 * Safety gate for structural/attribute mutations: the mutated file must parse without new
 * compiler errors, keep the expected number of elements (catches a span cut mid-tag that the
 * lenient compiler would still accept), and the target element must be found again at its new
 * loc with exactly the expected outer source.
 */
export async function verifyMutatedSource(input: {
  originalSource: string;
  patchedSource: string;
  file: string;
  expect: MutationExpectation;
}): Promise<{ ok: true; inspected: InspectResult | null } | { ok: false; error: string }> {
  try {
    const [errorsBefore, errorsAfter, before, after] = await Promise.all([
      countAstroParseErrors(input.originalSource),
      countAstroParseErrors(input.patchedSource),
      parse(input.originalSource, { position: true }),
      parse(input.patchedSource, { position: true }),
    ]);
    if (errorsAfter > errorsBefore) {
      return { ok: false, error: 'Edit would produce an Astro file that does not compile' };
    }
    const delta =
      countElementNodes(after.ast as unknown as AstNode) - countElementNodes(before.ast as unknown as AstNode);
    if (delta !== input.expect.elementDelta) {
      return { ok: false, error: 'Edit changed the page structure unexpectedly; refusing to save' };
    }
    if (
      countMalformedElements(input.patchedSource, after.ast as unknown as AstNode) >
      countMalformedElements(input.originalSource, before.ast as unknown as AstNode)
    ) {
      return { ok: false, error: 'Edit would leave an element unclosed; refusing to save' };
    }
    if (input.expect.loc === null) return { ok: true, inspected: null };
    const re = await inspectAstroElement(input.patchedSource, input.expect.loc, { file: input.file });
    if (
      !re ||
      (input.expect.tagName !== undefined && re.tagName !== input.expect.tagName) ||
      (input.expect.outerSource !== undefined && re.outerSource !== input.expect.outerSource)
    ) {
      return { ok: false, error: 'Edit changed the page structure around the element; refusing to save' };
    }
    return { ok: true, inspected: re };
  } catch (err) {
    return {
      ok: false,
      error: `Edit would produce an unparseable Astro file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function mutateAstroElement(
  input: MutateElementInput,
): Promise<MutateElementResult> {
  const absPath = path.resolve(input.repoRoot, input.relFile);
  if (!absPath.startsWith(path.resolve(input.repoRoot) + path.sep)) {
    return { ok: false, code: 400, error: 'Invalid file path' };
  }
  if (input.relFile === '.github' || input.relFile.startsWith('.github/')) {
    return { ok: false, code: 400, error: '.github/** is protected' };
  }
  if (path.extname(absPath).toLowerCase() !== '.astro') {
    return { ok: false, code: 400, error: 'Only .astro files can be edited directly' };
  }

  const urlHelperAbs = await resolveUrlHelperAbs(input.repoRoot);
  const hasUrlHelperFile = Boolean(urlHelperAbs);

  return input.fileLock.withLock(input.relFile, async () => {
    let source: string;
    try {
      source = await fs.readFile(absPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return { ok: false, code: 404, error: `File not found: ${input.relFile}` };
    }

    if (!parseLoc(input.loc)) {
      return { ok: false, code: 400, error: 'Invalid source location' };
    }
    const staleError = 'File changed on disk since you selected this element. Please re-click to refresh.';
    const disabledReason = await inlineEditingDisabledReason(input.repoRoot);
    const currentFileHash = sha256(source);
    const fileChanged = Boolean(input.expectedFileHash) && input.expectedFileHash !== currentFileHash;

    let loc = input.loc;
    let relocated = false;
    if (fileChanged) {
      // The file is not the one the client inspected: find the element by content instead of
      // trusting a loc that may now point somewhere else.
      const matches = await findElementsByOuterHash(source, input.expectedOuterHash, input.relFile);
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
      relocated = matches[0] !== loc;
      if (relocated) console.info(`[halley-dev-edit] relocated stale mutation in ${input.relFile}: ${loc} -> ${matches[0]}`);
      loc = matches[0]!;
    }

    const inspected = await inspectAstroElement(source, loc, { file: input.relFile, disabledReason });
    if (!inspected) {
      return { ok: false, code: 404, error: `Element not found at ${loc}` };
    }
    if (!inspected.outerSource) {
      // computeOuterSpan refuses spans that do not end in the element's own closing tag.
      return {
        ok: false,
        code: 422,
        error: `The <${inspected.tagName}> element's boundaries are ambiguous in the source — Ask Halley to edit it.`,
      };
    }
    if (inspected.outerSnapshotHash !== input.expectedOuterHash) {
      return { ok: false, code: 409, error: staleError };
    }
    if (inspected.blockedReason) {
      return { ok: false, code: 422, error: inspected.blockedReason };
    }

    const m = input.mutation;
    const parsedInputLoc = parseLoc(loc)!;
    const parsedRoot = (await parse(source, { position: true })).ast as unknown as AstNode;
    const srcBuf = Buffer.from(source, 'utf8');
    const locatedTarget = findElementWithContext(
      parsedRoot,
      srcBuf,
      lineByteColToByteOffset(srcBuf, parsedInputLoc.line, parsedInputLoc.column),
    );
    if (!locatedTarget) {
      return { ok: false, code: 404, error: `Element not found at ${loc}` };
    }
    const subtreeElementCount = countElementNodes(locatedTarget.node);

    /** Verifies the mutated source, then writes it atomically; returns an error result or the re-inspection. */
    const commit = async (
      patched: string,
      expectation: MutationExpectation,
    ): Promise<{ ok: true; re: InspectResult | null } | { ok: false; code: 422; error: string }> => {
      const verified = await verifyMutatedSource({
        originalSource: source,
        patchedSource: patched,
        file: input.relFile,
        expect: expectation,
      });
      if (!verified.ok) return { ok: false, code: 422, error: verified.error };
      await writeFileAtomic(absPath, patched);
      return { ok: true, re: verified.inspected };
    };
    const common = (patched: string) => ({
      beforeSource: source,
      afterSource: patched,
      newFileHash: sha256(patched),
      relocated,
    });
    /** Loc of the element whose `<` lands at `charOffset` in `patched`. */
    const locAt = (patched: string, charOffset: number) => locForElementStartingAt(patched, charOffset) ?? '';

    // ------------------------------------------------------------------
    // 1. set-link (<a> href + target="_blank" + rel)
    // ------------------------------------------------------------------
    if (m.kind === 'set-link') {
      if (!inspected.capabilities.link?.canEdit) {
        return { ok: false, code: 422, error: 'This link has a dynamic href — Ask Halley to edit it.' };
      }
      const norm = normalizeHref(m.href, input.previewBase, input.originalBase);
      if (norm.kind === 'invalid') {
        return { ok: false, code: 400, error: 'Invalid link URL' };
      }

      const openTag = source.slice(inspected.outerStartOffset, inspected.openTagEndOffset);
      let needsUrlImport = false;
      let hrefAttrVal: string;
      if (norm.kind === 'internal' && hasUrlHelperFile) {
        needsUrlImport = true;
        const safePath = norm.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        hrefAttrVal = `href={url('${safePath}')}`;
      } else {
        hrefAttrVal = `href="${escapeAttr(norm.value)}"`;
      }

      const updates: Record<string, string | null> = { href: hrefAttrVal };
      let appliedTarget = '';
      let appliedRel = '';
      if (m.openInNewTab === true) {
        updates.target = 'target="_blank"';
        updates.rel = 'rel="noopener noreferrer"';
        appliedTarget = '_blank';
        appliedRel = 'noopener noreferrer';
      } else if (m.openInNewTab === false) {
        updates.target = null;
        updates.rel = null;
      }

      const nextOpenTag = rewriteOpeningTagAttrs(openTag, updates);
      const prefixBeforeEnd = source.slice(0, inspected.openTagEndOffset);
      const afterLine = countNewlines(prefixBeforeEnd) + 1;
      const sameLineEndCol = byteColumnInLastLine(prefixBeforeEnd);
      const afterLineDelta = countNewlines(nextOpenTag) - countNewlines(openTag);
      const newEndCol = byteColumnInLastLine(source.slice(0, inspected.outerStartOffset) + nextOpenTag);
      const sameLineByteDelta = newEndCol - sameLineEndCol;

      let patched =
        source.slice(0, inspected.outerStartOffset) +
        nextOpenTag +
        source.slice(inspected.openTagEndOffset);

      let topLineDelta = 0;
      if (needsUrlImport && urlHelperAbs) {
        const beforeLines = countNewlines(patched);
        patched = await injectUrlImportIfMissing(patched, absPath, urlHelperAbs);
        topLineDelta = countNewlines(patched) - beforeLines;
      }

      // The url import (if any) lands in the frontmatter, i.e. before the element.
      const importShift = patched.length - (source.length - openTag.length + nextOpenTag.length);
      const newStart = inspected.outerStartOffset + importShift;
      const newLoc = locAt(patched, newStart);
      const committed = await commit(patched, {
        elementDelta: 0,
        loc: newLoc,
        tagName: inspected.tagName,
        outerSource: nextOpenTag + inspected.outerSource.slice(openTag.length),
      });
      if (!committed.ok) return committed;
      const re = committed.re;

      return {
        ok: true,
        kind: 'set-link',
        summary: `Updated link in ${input.relFile}`,
        ...common(patched),
        newLoc,
        newHash: re?.snapshotHash ?? inspected.snapshotHash,
        newOuterHash: re?.outerSnapshotHash ?? '',
        topLineDelta,
        afterLine,
        afterLineDelta,
        sameLineEndCol,
        sameLineByteDelta,
        resolvedHref:
          norm.kind === 'internal' ? resolvePreviewUrl(norm.value, input.previewBase) : norm.value,
        appliedTarget,
        appliedRel,
      };
    }

    // ------------------------------------------------------------------
    // 2. set-image (<img> src + alt)
    // ------------------------------------------------------------------
    if (m.kind === 'set-image') {
      const imgCap = inspected.capabilities.image;
      if (!imgCap) {
        return { ok: false, code: 422, error: 'Selected element is not an <img>' };
      }
      if (m.src !== undefined && !imgCap.canEditSrc) {
        return { ok: false, code: 422, error: 'Image src is dynamic — Ask Halley to replace it.' };
      }
      if (m.alt !== undefined && !imgCap.canEditAlt) {
        return { ok: false, code: 422, error: 'Image alt is dynamic — Ask Halley to edit it.' };
      }

      const openTag = source.slice(inspected.outerStartOffset, inspected.openTagEndOffset);
      const updates: Record<string, string | null> = {};
      let needsUrlImport = false;
      let resolvedSrc: string | undefined;

      if (m.src !== undefined) {
        const norm = normalizeHref(m.src, input.previewBase, input.originalBase);
        if (norm.kind === 'invalid') {
          return { ok: false, code: 400, error: 'Invalid image URL' };
        }
        if (norm.kind === 'internal' && hasUrlHelperFile) {
          needsUrlImport = true;
          const safePath = norm.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          updates.src = `src={url('${safePath}')}`;
          resolvedSrc = resolvePreviewUrl(norm.value, input.previewBase);
        } else {
          updates.src = `src="${escapeAttr(norm.value)}"`;
          resolvedSrc =
            norm.kind === 'internal' ? resolvePreviewUrl(norm.value, input.previewBase) : norm.value;
        }
      }

      if (m.alt !== undefined) {
        updates.alt = `alt="${escapeAttr(m.alt)}"`;
      }

      const nextOpenTag = rewriteOpeningTagAttrs(openTag, updates);
      const prefixBeforeEnd = source.slice(0, inspected.openTagEndOffset);
      const afterLine = countNewlines(prefixBeforeEnd) + 1;
      const sameLineEndCol = byteColumnInLastLine(prefixBeforeEnd);
      const afterLineDelta = countNewlines(nextOpenTag) - countNewlines(openTag);
      const newEndCol = byteColumnInLastLine(source.slice(0, inspected.outerStartOffset) + nextOpenTag);
      const sameLineByteDelta = newEndCol - sameLineEndCol;

      let patched =
        source.slice(0, inspected.outerStartOffset) +
        nextOpenTag +
        source.slice(inspected.openTagEndOffset);

      let topLineDelta = 0;
      if (needsUrlImport && urlHelperAbs) {
        const beforeLines = countNewlines(patched);
        patched = await injectUrlImportIfMissing(patched, absPath, urlHelperAbs);
        topLineDelta = countNewlines(patched) - beforeLines;
      }

      // The url import (if any) lands in the frontmatter, i.e. before the element.
      const importShift = patched.length - (source.length - openTag.length + nextOpenTag.length);
      const newStart = inspected.outerStartOffset + importShift;
      const newLoc = locAt(patched, newStart);
      const committed = await commit(patched, {
        elementDelta: 0,
        loc: newLoc,
        tagName: inspected.tagName,
        outerSource: nextOpenTag + inspected.outerSource.slice(openTag.length),
      });
      if (!committed.ok) return committed;
      const re = committed.re;

      return {
        ok: true,
        kind: 'set-image',
        summary: m.src !== undefined ? `Replaced image in ${input.relFile}` : `Updated image alt in ${input.relFile}`,
        ...common(patched),
        newLoc,
        newHash: re?.snapshotHash ?? '',
        newOuterHash: re?.outerSnapshotHash ?? '',
        topLineDelta,
        afterLine,
        afterLineDelta,
        sameLineEndCol,
        sameLineByteDelta,
        resolvedSrc,
        appliedAlt: m.alt,
      };
    }

    // ------------------------------------------------------------------
    // 3. set-style (safe static Tailwind class presets)
    // ------------------------------------------------------------------
    if (m.kind === 'set-style') {
      const styleCap = inspected.capabilities.style;
      if (!styleCap || !styleCap.canEdit) {
        return {
          ok: false,
          code: 422,
          error: styleCap?.reason || 'Element classes cannot be edited directly — Ask Halley.',
        };
      }

      const nextClasses = applyTailwindStylePresets(styleCap.classes, {
        align: m.align,
        objectPosition: m.objectPosition,
        spacing: m.spacing,
      });
      const classStr = nextClasses.join(' ');
      const openTag = source.slice(inspected.outerStartOffset, inspected.openTagEndOffset);
      const nextOpenTag = rewriteOpeningTagAttrs(openTag, {
        class: classStr ? `class="${escapeAttr(classStr)}"` : null,
      });

      const prefixBeforeEnd = source.slice(0, inspected.openTagEndOffset);
      const afterLine = countNewlines(prefixBeforeEnd) + 1;
      const sameLineEndCol = byteColumnInLastLine(prefixBeforeEnd);
      const afterLineDelta = countNewlines(nextOpenTag) - countNewlines(openTag);
      const newEndCol = byteColumnInLastLine(source.slice(0, inspected.outerStartOffset) + nextOpenTag);
      const sameLineByteDelta = newEndCol - sameLineEndCol;

      const patched =
        source.slice(0, inspected.outerStartOffset) +
        nextOpenTag +
        source.slice(inspected.openTagEndOffset);

      const newLoc = locAt(patched, inspected.outerStartOffset);
      const committed = await commit(patched, {
        elementDelta: 0,
        loc: newLoc,
        tagName: inspected.tagName,
        outerSource: nextOpenTag + inspected.outerSource.slice(openTag.length),
      });
      if (!committed.ok) return committed;
      const re = committed.re;

      return {
        ok: true,
        kind: 'set-style',
        summary: `Updated style in ${input.relFile}`,
        ...common(patched),
        newLoc,
        newHash: re?.snapshotHash ?? inspected.snapshotHash,
        newOuterHash: re?.outerSnapshotHash ?? '',
        topLineDelta: 0,
        afterLine,
        afterLineDelta,
        sameLineEndCol,
        sameLineByteDelta,
        appliedClass: classStr,
      };
    }

    // ------------------------------------------------------------------
    // 4. duplicate
    // ------------------------------------------------------------------
    if (m.kind === 'duplicate') {
      if (!inspected.capabilities.structural.canDuplicate) {
        return {
          ok: false,
          code: 422,
          error: inspected.capabilities.structural.blockReason || 'Cannot duplicate this element',
        };
      }
      const indent = getLineIndentAt(source, inspected.outerStartOffset);
      const cloned = stripStaticIds(inspected.outerSource);
      const insertion = `\n${indent}${cloned}`;

      const prefixBeforeEnd = source.slice(0, inspected.outerEndOffset);
      const afterLine = countNewlines(prefixBeforeEnd) + 1;
      const sameLineEndCol = byteColumnInLastLine(prefixBeforeEnd);
      const afterLineDelta = countNewlines(insertion);
      const newEndCol = byteColumnInLastLine(prefixBeforeEnd + insertion);
      const sameLineByteDelta = newEndCol - sameLineEndCol;

      const patched =
        source.slice(0, inspected.outerEndOffset) +
        insertion +
        source.slice(inspected.outerEndOffset);

      const cloneLoc = locAt(patched, inspected.outerEndOffset + 1 + indent.length);
      const committed = await commit(patched, {
        elementDelta: subtreeElementCount,
        loc: cloneLoc,
        tagName: inspected.tagName,
        outerSource: cloned,
      });
      if (!committed.ok) return committed;
      const re = committed.re;
      const subtreeLocs = await collectSubtreeLocs(patched, cloneLoc);

      return {
        ok: true,
        kind: 'duplicate',
        summary: `Duplicated <${inspected.tagName}> in ${input.relFile}`,
        ...common(patched),
        newLoc: cloneLoc,
        newHash: re?.snapshotHash ?? '',
        newOuterHash: re?.outerSnapshotHash ?? '',
        topLineDelta: 0,
        afterLine,
        afterLineDelta,
        sameLineEndCol,
        sameLineByteDelta,
        subtreeLocs,
      };
    }

    // ------------------------------------------------------------------
    // 5. delete
    // ------------------------------------------------------------------
    if (m.kind === 'delete') {
      if (!inspected.capabilities.structural.canDelete) {
        return {
          ok: false,
          code: 422,
          error: inspected.capabilities.structural.blockReason || 'Cannot delete this element',
        };
      }

      // If element occupies whole lines, also remove its leading indent and trailing newline
      let removeStart = inspected.outerStartOffset;
      let removeEnd = inspected.outerEndOffset;
      const lineStart = source.lastIndexOf('\n', Math.max(0, removeStart - 1)) + 1;
      const leadingOnLine = source.slice(lineStart, removeStart);
      const trailingAfter = source.slice(removeEnd);
      const trailingNlMatch = /^[ \t]*\r?\n/.exec(trailingAfter);

      if (/^[ \t]*$/.test(leadingOnLine) && trailingNlMatch) {
        removeStart = lineStart;
        removeEnd += trailingNlMatch[0]!.length;
      }

      const removed = source.slice(removeStart, removeEnd);
      const prefixBeforeEnd = source.slice(0, removeEnd);
      const afterLine = countNewlines(prefixBeforeEnd) + 1;
      const sameLineEndCol = byteColumnInLastLine(prefixBeforeEnd);
      const afterLineDelta = -countNewlines(removed);
      const newEndCol = byteColumnInLastLine(source.slice(0, removeStart));
      const sameLineByteDelta = newEndCol - sameLineEndCol;

      const patched = source.slice(0, removeStart) + source.slice(removeEnd);
      const committed = await commit(patched, { elementDelta: -subtreeElementCount, loc: null });
      if (!committed.ok) return committed;

      return {
        ok: true,
        kind: 'delete',
        summary: `Deleted <${inspected.tagName}> in ${input.relFile}`,
        ...common(patched),
        newLoc: '',
        newHash: '',
        newOuterHash: '',
        topLineDelta: 0,
        afterLine,
        afterLineDelta,
        sameLineEndCol,
        sameLineByteDelta,
      };
    }

    // ------------------------------------------------------------------
    // 6. move (swap with adjacent static sibling)
    // ------------------------------------------------------------------
    if (m.kind === 'move') {
      const canMove =
        m.direction === 'up'
          ? inspected.capabilities.structural.canMoveUp
          : inspected.capabilities.structural.canMoveDown;
      if (!canMove) {
        return {
          ok: false,
          code: 422,
          error:
            inspected.capabilities.structural.blockReason ||
            `Cannot move <${inspected.tagName}> ${m.direction}`,
        };
      }

      const buf = srcBuf;
      const sibNode = findAdjacentStaticSiblingNode(locatedTarget, buf, m.direction);
      if (!sibNode) {
        return { ok: false, code: 422, error: `No static sibling to move ${m.direction}` };
      }
      const sibSpan = computeOuterSpan(buf, sibNode);
      if (!sibSpan) {
        return { ok: false, code: 422, error: 'Sibling span could not be resolved' };
      }

      const firstStart = Math.min(inspected.outerStartOffset, sibSpan.outerStartOffset);
      const firstEnd =
        firstStart === inspected.outerStartOffset ? inspected.outerEndOffset : sibSpan.outerEndOffset;
      const secondStart = Math.max(inspected.outerStartOffset, sibSpan.outerStartOffset);
      const secondEnd =
        secondStart === inspected.outerStartOffset ? inspected.outerEndOffset : sibSpan.outerEndOffset;

      const firstText = source.slice(firstStart, firstEnd);
      const between = source.slice(firstEnd, secondStart);
      const secondText = source.slice(secondStart, secondEnd);

      const patched =
        source.slice(0, firstStart) +
        secondText +
        between +
        firstText +
        source.slice(secondEnd);

      // New locs (Astro 5 convention) of both swapped elements
      const firstNewLoc = locAt(patched, firstStart);
      const secondNewLoc = locAt(patched, firstStart + secondText.length + between.length);

      const movedLoc = m.direction === 'up' ? firstNewLoc : secondNewLoc;
      const swappedLoc = m.direction === 'up' ? secondNewLoc : firstNewLoc;

      const committed = await commit(patched, {
        elementDelta: 0,
        loc: movedLoc,
        tagName: inspected.tagName,
        outerSource: inspected.outerSource,
      });
      if (!committed.ok) return committed;
      const re = committed.re;
      const [subtreeLocs, swappedSubtreeLocs] = await Promise.all([
        collectSubtreeLocs(patched, movedLoc),
        collectSubtreeLocs(patched, swappedLoc),
      ]);

      return {
        ok: true,
        kind: 'move',
        summary: `Moved <${inspected.tagName}> ${m.direction} in ${input.relFile}`,
        ...common(patched),
        newLoc: movedLoc,
        newHash: re?.snapshotHash ?? inspected.snapshotHash,
        newOuterHash: re?.outerSnapshotHash ?? '',
        topLineDelta: 0,
        afterLine: 0,
        afterLineDelta: 0,
        sameLineEndCol: 0,
        sameLineByteDelta: 0,
        subtreeLocs,
        swappedSubtreeLocs,
      };
    }

    // ------------------------------------------------------------------
    // 7. add-block (insert new static sibling after selected element)
    // ------------------------------------------------------------------
    if (m.kind === 'add-block') {
      const allowedKinds = inspected.capabilities.structural.allowedAddKinds;
      if (
        !inspected.capabilities.structural.canAddAfter ||
        (Array.isArray(allowedKinds) && !allowedKinds.includes(m.blockKind))
      ) {
        return {
          ok: false,
          code: 422,
          error:
            inspected.capabilities.structural.blockReason ||
            `Cannot insert ${m.blockKind} directly inside <${locatedTarget?.parent?.name || 'this container'}>`,
        };
      }

      const root = parsedRoot;
      const located = locatedTarget;

      const targetTag =
        m.blockKind === 'paragraph'
          ? 'p'
          : m.blockKind === 'heading'
            ? 'h2'
            : m.blockKind === 'list-item'
              ? 'li'
              : 'img';

      const inheritedClass =
        (located?.parent ? findMatchingTagClassInNode(located.parent, targetTag) : null) ||
        findMatchingTagClassRecursive(root, targetTag) ||
        DEFAULT_BLOCK_CLASSES[m.blockKind];

      const classAttr = inheritedClass ? ` class="${escapeAttr(inheritedClass)}"` : '';
      let needsUrlImport = false;
      let astroSnippet = '';
      let insertedHtml = '';

      if (m.blockKind === 'paragraph') {
        astroSnippet = `<p${classAttr}>New paragraph</p>`;
        insertedHtml = astroSnippet;
      } else if (m.blockKind === 'heading') {
        astroSnippet = `<h2${classAttr}>New heading</h2>`;
        insertedHtml = astroSnippet;
      } else if (m.blockKind === 'list-item') {
        astroSnippet = `<li${classAttr}>New list item</li>`;
        insertedHtml = astroSnippet;
      } else {
        const rawSrc = m.imageSrc?.trim() || '';
        const alt = m.imageAlt ?? '';
        const norm = rawSrc ? normalizeHref(rawSrc, input.previewBase, input.originalBase) : { kind: 'invalid' as const, value: '' };
        if (norm.kind === 'internal' && hasUrlHelperFile) {
          needsUrlImport = true;
          const safePath = norm.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          astroSnippet = `<img src={url('${safePath}')} alt="${escapeAttr(alt)}"${classAttr} />`;
          insertedHtml = `<img src="${escapeAttr(resolvePreviewUrl(norm.value, input.previewBase))}" alt="${escapeAttr(alt)}"${classAttr} />`;
        } else if (norm.kind !== 'invalid') {
          astroSnippet = `<img src="${escapeAttr(norm.value)}" alt="${escapeAttr(alt)}"${classAttr} />`;
          const previewSrc =
            norm.kind === 'internal' ? resolvePreviewUrl(norm.value, input.previewBase) : norm.value;
          insertedHtml = `<img src="${escapeAttr(previewSrc)}" alt="${escapeAttr(alt)}"${classAttr} />`;
        } else {
          return { ok: false, code: 400, error: 'Image block requires a valid imageSrc' };
        }
      }

      const indent = getLineIndentAt(source, inspected.outerStartOffset);
      const insertion = `\n${indent}${astroSnippet}`;
      const prefixBeforeEnd = source.slice(0, inspected.outerEndOffset);
      const afterLine = countNewlines(prefixBeforeEnd) + 1;
      const sameLineEndCol = byteColumnInLastLine(prefixBeforeEnd);
      const afterLineDelta = countNewlines(insertion);
      const newEndCol = byteColumnInLastLine(prefixBeforeEnd + insertion);
      const sameLineByteDelta = newEndCol - sameLineEndCol;

      let patched =
        source.slice(0, inspected.outerEndOffset) +
        insertion +
        source.slice(inspected.outerEndOffset);

      let topLineDelta = 0;
      if (needsUrlImport && urlHelperAbs) {
        const beforeLines = countNewlines(patched);
        patched = await injectUrlImportIfMissing(patched, absPath, urlHelperAbs);
        topLineDelta = countNewlines(patched) - beforeLines;
      }

      // The url import (if any) lands in the frontmatter, i.e. before the insertion point.
      const importShift = patched.length - (source.length + insertion.length);
      const insertedLoc = locAt(patched, inspected.outerEndOffset + 1 + indent.length + importShift);
      const committed = await commit(patched, {
        elementDelta: 1,
        loc: insertedLoc,
        tagName: targetTag,
        outerSource: astroSnippet,
      });
      if (!committed.ok) return committed;
      const re = committed.re;
      const subtreeLocs = await collectSubtreeLocs(patched, insertedLoc);

      return {
        ok: true,
        kind: 'add-block',
        summary: `Added ${m.blockKind} in ${input.relFile}`,
        ...common(patched),
        newLoc: insertedLoc,
        newHash: re?.snapshotHash ?? '',
        newOuterHash: re?.outerSnapshotHash ?? '',
        topLineDelta,
        afterLine,
        afterLineDelta,
        sameLineEndCol,
        sameLineByteDelta,
        subtreeLocs,
        insertedHtml,
      };
    }

    return { ok: false, code: 400, error: 'Unsupported mutation kind' };
  });
}

// Re-export helper for tests if needed
export { byteOffsetToCharOffset };
