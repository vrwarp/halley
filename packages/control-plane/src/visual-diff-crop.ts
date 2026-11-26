import type { VisualDiffHighlightDto, VisualDiffHunkDto, VisualDiffViewportShotDto } from '@halley/shared';
import sharp from 'sharp';

export const CHANNEL_TOLERANCE = 12;
export const MAX_NOISE_PIXELS_PER_ROW = 2;
export const PADDING_Y = 96;
export const PADDING_X = 96;
export const MIN_UNCHANGED_BAND_PX = 240;
export const MIN_DIVIDER_GAP_PX = 64;
export const MIN_DESKTOP_CROP_WIDTH = 640;
export const DESKTOP_TRIM_THRESHOLD_WIDTH = 1000;
export const MAX_HUNKS_PER_PAGE = 4;
export const MAX_HUNK_HEIGHT = 1800;
export const DRAFT_ONLY_PREVIEW_HEIGHT = 1400;

interface DecodedImage {
  data: Buffer;
  width: number;
  height: number;
}

interface UnchangedBand {
  liveY: number;
  draftY: number;
  length: number;
}

interface HunkSpan {
  liveStart: number;
  liveEnd: number;
  draftStart: number;
  draftEnd: number;
}

async function decodeRgba(buf: Buffer): Promise<DecodedImage | null> {
  try {
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || data.length < info.width * info.height * 4) {
      return null;
    }
    return { data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

function rowsMatch(
  a: Buffer,
  b: Buffer,
  width: number,
  yA: number,
  yB: number,
  tolerance = CHANNEL_TOLERANCE,
  maxNoisePixels = MAX_NOISE_PIXELS_PER_ROW,
): boolean {
  const rowBytes = width * 4;
  const offA = yA * rowBytes;
  const offB = yB * rowBytes;
  let bad = 0;
  for (let i = 0; i < rowBytes; i += 4) {
    const dr = Math.abs(a[offA + i]! - b[offB + i]!);
    const dg = Math.abs(a[offA + i + 1]! - b[offB + i + 1]!);
    const db = Math.abs(a[offA + i + 2]! - b[offB + i + 2]!);
    const da = Math.abs(a[offA + i + 3]! - b[offB + i + 3]!);
    if (dr > tolerance || dg > tolerance || db > tolerance || da > tolerance) {
      bad += 1;
      if (bad > maxNoisePixels) return false;
    }
  }
  return true;
}

/**
 * Computes a quantized 32-bit FNV-1a row signature (robust to minor anti-aliasing jitter)
 * plus a flag indicating whether the row has meaningful horizontal structure
 * (preventing flat solid-color whitespace rows from becoming false anchors).
 */
function computeRowSignatures(img: DecodedImage, startY: number, endY: number): {
  hashes: Uint32Array;
  structured: Uint8Array;
} {
  const len = Math.max(0, endY - startY);
  const hashes = new Uint32Array(len);
  const structured = new Uint8Array(len);
  const { data, width } = img;
  const rowBytes = width * 4;
  const bucketPx = 8;

  for (let r = 0; r < len; r++) {
    const rowOff = (startY + r) * rowBytes;
    let hash = 2166136261;
    let transitions = 0;
    let prevR = -1;
    let prevG = -1;
    let prevB = -1;

    for (let x = 0; x < width; x += bucketPx) {
      const sampleEnd = Math.min(width, x + bucketPx);
      const count = sampleEnd - x;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let sx = x; sx < sampleEnd; sx++) {
        const idx = rowOff + sx * 4;
        sr += data[idx]!;
        sg += data[idx + 1]!;
        sb += data[idx + 2]!;
      }
      const mr = (sr / count) | 0;
      const mg = (sg / count) | 0;
      const mb = (sb / count) | 0;

      if (prevR >= 0) {
        if (Math.abs(mr - prevR) > 16 || Math.abs(mg - prevG) > 16 || Math.abs(mb - prevB) > 16) {
          transitions += 1;
        }
      }
      prevR = mr;
      prevG = mg;
      prevB = mb;

      // Quantize to 4 bits per channel so +/- 7 anti-aliasing jitter hashes identically
      const q = ((mr >> 4) << 8) | ((mg >> 4) << 4) | (mb >> 4);
      hash ^= q;
      hash = Math.imul(hash, 16777619) >>> 0;
    }

    hashes[r] = hash;
    structured[r] = transitions >= 2 ? 1 : 0;
  }

  return { hashes, structured };
}

function longestIncreasingAnchorPairs(
  pairs: Array<{ liveY: number; draftY: number }>,
): Array<{ liveY: number; draftY: number }> {
  if (pairs.length <= 1) return pairs;
  // Pairs are already sorted by liveY ascending; find LIS on draftY
  const n = pairs.length;
  const tails: number[] = [];
  const prev = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const val = pairs[i]!.draftY;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]!]!.draftY < val) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }

  const out: Array<{ liveY: number; draftY: number }> = [];
  let k = tails[tails.length - 1]!;
  while (k >= 0) {
    out.push(pairs[k]!);
    k = prev[k]!;
  }
  out.reverse();
  return out;
}

/**
 * Finds unchanged horizontal bands of at least MIN_UNCHANGED_BAND_PX rows between
 * Live [liveStart..liveEnd) and Draft [draftStart..draftEnd), even when height shifts
 * above cause liveY !== draftY.
 */
function findMiddleUnchangedBands(
  live: DecodedImage,
  draft: DecodedImage,
  liveStart: number,
  liveEnd: number,
  draftStart: number,
  draftEnd: number,
): UnchangedBand[] {
  const liveSpan = liveEnd - liveStart;
  const draftSpan = draftEnd - draftStart;
  if (liveSpan < MIN_UNCHANGED_BAND_PX || draftSpan < MIN_UNCHANGED_BAND_PX) {
    return [];
  }

  const width = live.width;
  const liveSig = computeRowSignatures(live, liveStart, liveEnd);
  const draftSig = computeRowSignatures(draft, draftStart, draftEnd);

  // 1. Patience-style unique structured row anchors
  const liveUnique = new Map<number, number>();
  const liveDup = new Set<number>();
  for (let i = 0; i < liveSig.hashes.length; i++) {
    if (!liveSig.structured[i]) continue;
    const h = liveSig.hashes[i]!;
    if (liveDup.has(h)) continue;
    if (liveUnique.has(h)) {
      liveUnique.delete(h);
      liveDup.add(h);
    } else {
      liveUnique.set(h, liveStart + i);
    }
  }

  const draftUnique = new Map<number, number>();
  const draftDup = new Set<number>();
  for (let i = 0; i < draftSig.hashes.length; i++) {
    if (!draftSig.structured[i]) continue;
    const h = draftSig.hashes[i]!;
    if (draftDup.has(h)) continue;
    if (draftUnique.has(h)) {
      draftUnique.delete(h);
      draftDup.add(h);
    } else {
      draftUnique.set(h, draftStart + i);
    }
  }

  const rawAnchors: Array<{ liveY: number; draftY: number }> = [];
  for (const [h, lY] of liveUnique.entries()) {
    const dY = draftUnique.get(h);
    if (dY !== undefined) {
      rawAnchors.push({ liveY: lY, draftY: dY });
    }
  }
  rawAnchors.sort((a, b) => a.liveY - b.liveY);
  const anchors = longestIncreasingAnchorPairs(rawAnchors);

  const bands: UnchangedBand[] = [];
  let curLiveMin = liveStart;
  let curDraftMin = draftStart;

  for (const anchor of anchors) {
    if (anchor.liveY < curLiveMin || anchor.draftY < curDraftMin) continue;
    if (!rowsMatch(live.data, draft.data, width, anchor.liveY, anchor.draftY)) continue;

    let lTop = anchor.liveY;
    let dTop = anchor.draftY;
    while (lTop > curLiveMin && dTop > curDraftMin && rowsMatch(live.data, draft.data, width, lTop - 1, dTop - 1)) {
      lTop -= 1;
      dTop -= 1;
    }

    let lBot = anchor.liveY + 1;
    let dBot = anchor.draftY + 1;
    while (lBot < liveEnd && dBot < draftEnd && rowsMatch(live.data, draft.data, width, lBot, dBot)) {
      lBot += 1;
      dBot += 1;
    }

    const length = lBot - lTop;
    if (length >= MIN_UNCHANGED_BAND_PX) {
      bands.push({ liveY: lTop, draftY: dTop, length });
      curLiveMin = lBot;
      curDraftMin = dBot;
    }
  }

  // 2. Fallback scan for equal-offset unchanged bands in any remaining large gap
  //    (covers pages where unchanged sections consist of repeated/non-unique rows)
  const gapBounds: Array<{ l0: number; l1: number; d0: number; d1: number }> = [];
  let prevL = liveStart;
  let prevD = draftStart;
  for (const b of bands) {
    gapBounds.push({ l0: prevL, l1: b.liveY, d0: prevD, d1: b.draftY });
    prevL = b.liveY + b.length;
    prevD = b.draftY + b.length;
  }
  gapBounds.push({ l0: prevL, l1: liveEnd, d0: prevD, d1: draftEnd });

  const extraBands: UnchangedBand[] = [];
  for (const g of gapBounds) {
    const gL = g.l1 - g.l0;
    const gD = g.d1 - g.d0;
    if (gL < MIN_UNCHANGED_BAND_PX || gD < MIN_UNCHANGED_BAND_PX) continue;

    // Try candidate vertical shifts: 0 (same Y) and (gD - gL) (aligned to bottom of gap)
    const shifts = gD === gL ? [0] : [gD - gL, 0];
    let bestBand: UnchangedBand | null = null;
    for (const shift of shifts) {
      let runStartL = -1;
      let runLen = 0;
      for (let lY = g.l0; lY < g.l1; lY++) {
        const dY = lY - g.l0 + g.d0 + shift;
        if (dY < g.d0 || dY >= g.d1) {
          if (runLen >= MIN_UNCHANGED_BAND_PX && (!bestBand || runLen > bestBand.length)) {
            bestBand = { liveY: runStartL, draftY: runStartL - g.l0 + g.d0 + shift, length: runLen };
          }
          runStartL = -1;
          runLen = 0;
          continue;
        }
        if (rowsMatch(live.data, draft.data, width, lY, dY)) {
          if (runStartL < 0) runStartL = lY;
          runLen += 1;
        } else {
          if (runLen >= MIN_UNCHANGED_BAND_PX && (!bestBand || runLen > bestBand.length)) {
            bestBand = { liveY: runStartL, draftY: runStartL - g.l0 + g.d0 + shift, length: runLen };
          }
          runStartL = -1;
          runLen = 0;
        }
      }
      if (runLen >= MIN_UNCHANGED_BAND_PX && (!bestBand || runLen > bestBand.length)) {
        bestBand = { liveY: runStartL, draftY: runStartL - g.l0 + g.d0 + shift, length: runLen };
      }
    }
    if (bestBand) extraBands.push(bestBand);
  }

  if (extraBands.length > 0) {
    bands.push(...extraBands);
    bands.sort((a, b) => a.liveY - b.liveY);
  }

  return bands;
}

function computeHorizontalCrop(
  live: DecodedImage,
  draft: DecodedImage,
  span: HunkSpan,
): { cropX: number; cropWidth: number } {
  const width = draft.width;
  if (width < DESKTOP_TRIM_THRESHOLD_WIDTH) {
    return { cropX: 0, cropWidth: width };
  }

  const liveH = Math.max(0, span.liveEnd - span.liveStart);
  const draftH = Math.max(0, span.draftEnd - span.draftStart);
  const overlapH = Math.min(liveH, draftH);
  const rowBytes = width * 4;

  let minX = width;
  let maxX = -1;

  for (let r = 0; r < overlapH; r++) {
    const offL = (span.liveStart + r) * rowBytes;
    const offD = (span.draftStart + r) * rowBytes;
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      const dr = Math.abs(live.data[offL + i]! - draft.data[offD + i]!);
      const dg = Math.abs(live.data[offL + i + 1]! - draft.data[offD + i + 1]!);
      const db = Math.abs(live.data[offL + i + 2]! - draft.data[offD + i + 2]!);
      const da = Math.abs(live.data[offL + i + 3]! - draft.data[offD + i + 3]!);
      if (dr > CHANNEL_TOLERANCE || dg > CHANNEL_TOLERANCE || db > CHANNEL_TOLERANCE || da > CHANNEL_TOLERANCE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }

  // Also inspect any extra added/removed rows beyond overlapH relative to their edge background
  if (liveH !== draftH) {
    const taller = draftH > liveH ? draft : live;
    const extraStart = (draftH > liveH ? span.draftStart : span.liveStart) + overlapH;
    const extraEnd = draftH > liveH ? span.draftEnd : span.liveEnd;
    for (let y = extraStart; y < extraEnd; y++) {
      const off = y * rowBytes;
      const bgR = taller.data[off]!;
      const bgG = taller.data[off + 1]!;
      const bgB = taller.data[off + 2]!;
      for (let x = 0; x < width; x++) {
        const i = off + x * 4;
        if (
          Math.abs(taller.data[i]! - bgR) > CHANNEL_TOLERANCE ||
          Math.abs(taller.data[i + 1]! - bgG) > CHANNEL_TOLERANCE ||
          Math.abs(taller.data[i + 2]! - bgB) > CHANNEL_TOLERANCE
        ) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
  }

  if (maxX < minX) {
    return { cropX: 0, cropWidth: width };
  }

  let left = Math.max(0, minX - PADDING_X);
  let right = Math.min(width, maxX + 1 + PADDING_X);
  let cropW = right - left;

  if (cropW < MIN_DESKTOP_CROP_WIDTH) {
    const center = (left + right) / 2;
    left = Math.round(center - MIN_DESKTOP_CROP_WIDTH / 2);
    if (left < 0) left = 0;
    if (left + MIN_DESKTOP_CROP_WIDTH > width) left = Math.max(0, width - MIN_DESKTOP_CROP_WIDTH);
    cropW = Math.min(width - left, MIN_DESKTOP_CROP_WIDTH);
  }

  return { cropX: left, cropWidth: cropW };
}

function remapHighlights(
  highlights: VisualDiffHighlightDto[],
  fullWidth: number,
  fullHeight: number,
  cropX: number,
  cropY: number,
  cropWidth: number,
  targetHeight: number,
): VisualDiffHighlightDto[] {
  if (highlights.length === 0 || fullWidth <= 0 || fullHeight <= 0 || cropWidth <= 0 || targetHeight <= 0) {
    return [];
  }
  const out: VisualDiffHighlightDto[] = [];
  const cropRight = cropX + cropWidth;
  const cropBottom = cropY + targetHeight;

  for (const h of highlights) {
    const pxLeft = (h.x / 100) * fullWidth;
    const pxTop = (h.y / 100) * fullHeight;
    const pxRight = pxLeft + (h.width / 100) * fullWidth;
    const pxBottom = pxTop + (h.height / 100) * fullHeight;

    const cLeft = Math.max(cropX, pxLeft);
    const cTop = Math.max(cropY, pxTop);
    const cRight = Math.min(cropRight, pxRight);
    const cBottom = Math.min(cropBottom, pxBottom);

    const cW = cRight - cLeft;
    const cH = cBottom - cTop;
    if (cW < 4 || cH < 4) continue;

    out.push({
      ...h,
      x: Math.round(((cLeft - cropX) / cropWidth) * 1000) / 10,
      y: Math.round(((cTop - cropY) / targetHeight) * 1000) / 10,
      width: Math.round((cW / cropWidth) * 1000) / 10,
      height: Math.round((cH / targetHeight) * 1000) / 10,
    });
  }
  return out;
}

async function cropAndPadWebp(
  srcBuf: Buffer,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  alignedHeight: number,
): Promise<string> {
  const safeH = Math.max(1, cropHeight);
  const safeW = Math.max(1, cropWidth);
  const extracted = await sharp(srcBuf)
    .extract({ left: cropX, top: cropY, width: safeW, height: safeH })
    .png()
    .toBuffer();

  if (alignedHeight <= safeH) {
    const webp = await sharp(extracted).webp({ quality: 82 }).toBuffer();
    return `data:image/webp;base64,${webp.toString('base64')}`;
  }

  const padBottom = alignedHeight - safeH;
  // Subtle neutral footer (#F5F5F4 stone-100) with a 1px #D6D3D1 hairline at the cut boundary
  const hairline = await sharp({
    create: {
      width: safeW,
      height: 1,
      channels: 4,
      background: { r: 214, g: 211, b: 209, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const webp = await sharp(extracted)
    .extend({
      top: 0,
      bottom: padBottom,
      left: 0,
      right: 0,
      background: { r: 245, g: 245, b: 244, alpha: 1 },
    })
    .composite([{ input: hairline, left: 0, top: safeH }])
    .webp({ quality: 82 })
    .toBuffer();

  return `data:image/webp;base64,${webp.toString('base64')}`;
}

export async function encodeFullWebpDataUrl(buf: Buffer): Promise<string> {
  try {
    const webp = await sharp(buf).webp({ quality: 80 }).toBuffer();
    return `data:image/webp;base64,${webp.toString('base64')}`;
  } catch {
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
}

export interface BuildReviewShotInput {
  draftBuf: Buffer;
  liveBuf?: Buffer;
  highlights: VisualDiffHighlightDto[];
  fallbackWidth: number;
  fallbackHeight: number;
  mode: 'cropped' | 'full';
}

/**
 * Builds a VisualDiffViewportShotDto from raw PNG (or fallback) Draft & Live captures.
 * - mode='full': encodes full page WebP (padded at bottom if Live & Draft heights differ)
 * - mode='cropped' with no Live: returns a top-of-page preview (0..1400px) + hasFullPage flag
 * - mode='cropped' with Live: runs top-down + bottom-up + anchored middle-band alignment,
 *   splits unchanged gaps >= 240px into up to 4 padded hunks, trims desktop X with 640px min width,
 *   pads height-mismatched hunks at the bottom, and remaps highlights per hunk.
 */
export async function buildVisualDiffShot(input: BuildReviewShotInput): Promise<VisualDiffViewportShotDto> {
  const { draftBuf, liveBuf, highlights, fallbackWidth, fallbackHeight, mode } = input;

  const draftImg = await decodeRgba(draftBuf);
  if (!draftImg) {
    // Graceful fallback for synthetic test buffers (non-image bytes)
    const draftUrl = `data:image/jpeg;base64,${draftBuf.toString('base64')}`;
    const liveUrl = liveBuf ? `data:image/jpeg;base64,${liveBuf.toString('base64')}` : undefined;
    return {
      draftScreenshotDataUrl: draftUrl,
      liveScreenshotDataUrl: liveUrl,
      highlights,
      width: fallbackWidth,
      height: fallbackHeight,
      fullWidth: fallbackWidth,
      fullHeight: fallbackHeight,
      hasFullPage: false,
    };
  }

  const liveImg = liveBuf ? await decodeRgba(liveBuf) : null;

  // Full-page mode: return full Live + Draft aligned to max height
  if (mode === 'full') {
    const fullW = draftImg.width;
    const fullH = liveImg ? Math.max(draftImg.height, liveImg.height) : draftImg.height;
    const draftUrl = await cropAndPadWebp(draftBuf, 0, 0, fullW, draftImg.height, fullH);
    const liveUrl =
      liveImg && liveBuf && liveImg.width === fullW
        ? await cropAndPadWebp(liveBuf, 0, 0, fullW, liveImg.height, fullH)
        : liveBuf
          ? await encodeFullWebpDataUrl(liveBuf)
          : undefined;

    const remapped = remapHighlights(highlights, draftImg.width, draftImg.height, 0, 0, fullW, fullH);
    return {
      draftScreenshotDataUrl: draftUrl,
      liveScreenshotDataUrl: liveUrl,
      highlights: remapped,
      width: fullW,
      height: fullH,
      fullWidth: draftImg.width,
      fullHeight: draftImg.height,
      hasFullPage: true,
    };
  }

  // Cropped mode — Draft-only (no Live capture available or mismatched viewport width)
  if (!liveImg || !liveBuf || liveImg.width !== draftImg.width) {
    const previewH = Math.min(draftImg.height, DRAFT_ONLY_PREVIEW_HEIGHT);
    const unchangedAfterPx = Math.max(0, draftImg.height - previewH);
    const draftUrl = await cropAndPadWebp(draftBuf, 0, 0, draftImg.width, previewH, previewH);
    const remapped = remapHighlights(
      highlights,
      draftImg.width,
      draftImg.height,
      0,
      0,
      draftImg.width,
      previewH,
    );
    const hunk: VisualDiffHunkDto = {
      id: 'hunk-0',
      draftScreenshotDataUrl: draftUrl,
      highlights: remapped,
      width: draftImg.width,
      height: previewH,
      draftCropY: 0,
      draftCropHeight: previewH,
      cropX: 0,
      cropWidth: draftImg.width,
      unchangedBeforePx: 0,
    };
    return {
      draftScreenshotDataUrl: draftUrl,
      highlights: remapped,
      width: draftImg.width,
      height: previewH,
      hunks: [hunk],
      unchangedAfterPx,
      identical: false,
      fullWidth: draftImg.width,
      fullHeight: draftImg.height,
      hasFullPage: unchangedAfterPx > 0,
    };
  }

  // Cropped mode — Live vs Draft pixel diffing
  const width = draftImg.width;
  const hLive = liveImg.height;
  const hDraft = draftImg.height;
  const minH = Math.min(hLive, hDraft);

  // 1. Top-down trim
  let topTrim = 0;
  while (topTrim < minH && rowsMatch(liveImg.data, draftImg.data, width, topTrim, topTrim)) {
    topTrim += 1;
  }

  // Identical full page
  if (topTrim === hLive && hLive === hDraft) {
    return {
      highlights: [],
      width,
      height: 0,
      hunks: [],
      unchangedAfterPx: 0,
      identical: true,
      fullWidth: width,
      fullHeight: hDraft,
      hasFullPage: true,
    };
  }

  // 2. Bottom-up trim (matching rows from the bottom of both images, resilient to height shifts)
  let bottomTrim = 0;
  const maxBottom = Math.min(hLive - topTrim, hDraft - topTrim);
  while (
    bottomTrim < maxBottom &&
    rowsMatch(liveImg.data, draftImg.data, width, hLive - 1 - bottomTrim, hDraft - 1 - bottomTrim)
  ) {
    bottomTrim += 1;
  }

  const activeLiveEnd = hLive - bottomTrim;
  const activeDraftEnd = hDraft - bottomTrim;

  // 3. Anchored middle-band alignment for multi-hunk splitting
  const middleBands = findMiddleUnchangedBands(
    liveImg,
    draftImg,
    topTrim,
    activeLiveEnd,
    topTrim,
    activeDraftEnd,
  );

  // Convert unchanged bands into changed hunk spans
  const rawSpans: HunkSpan[] = [];
  let curL = topTrim;
  let curD = topTrim;
  for (const band of middleBands) {
    if (band.liveY > curL || band.draftY > curD) {
      rawSpans.push({
        liveStart: curL,
        liveEnd: band.liveY,
        draftStart: curD,
        draftEnd: band.draftY,
      });
    }
    curL = band.liveY + band.length;
    curD = band.draftY + band.length;
  }
  if (activeLiveEnd > curL || activeDraftEnd > curD) {
    rawSpans.push({
      liveStart: curL,
      liveEnd: activeLiveEnd,
      draftStart: curD,
      draftEnd: activeDraftEnd,
    });
  }

  // Fallback safety if spans somehow ended empty despite height diff
  if (rawSpans.length === 0) {
    rawSpans.push({
      liveStart: topTrim,
      liveEnd: Math.max(topTrim + 1, activeLiveEnd),
      draftStart: topTrim,
      draftEnd: Math.max(topTrim + 1, activeDraftEnd),
    });
  }

  // 4. Expand each span by PADDING_Y (clamped) and merge overlapping/tiny-gap hunks
  const paddedSpans: HunkSpan[] = rawSpans.map((s) => ({
    liveStart: Math.max(0, s.liveStart - PADDING_Y),
    liveEnd: Math.min(hLive, s.liveEnd + PADDING_Y),
    draftStart: Math.max(0, s.draftStart - PADDING_Y),
    draftEnd: Math.min(hDraft, s.draftEnd + PADDING_Y),
  }));

  const merged: HunkSpan[] = [];
  for (const s of paddedSpans) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      (s.draftStart - prev.draftEnd < MIN_DIVIDER_GAP_PX || s.liveStart - prev.liveEnd < MIN_DIVIDER_GAP_PX)
    ) {
      prev.liveEnd = Math.max(prev.liveEnd, s.liveEnd);
      prev.draftEnd = Math.max(prev.draftEnd, s.draftEnd);
    } else {
      merged.push({ ...s });
    }
  }

  // 5. Enforce MAX_HUNKS_PER_PAGE by coalescing smallest unchanged gaps
  while (merged.length > MAX_HUNKS_PER_PAGE) {
    let bestIdx = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < merged.length - 1; i++) {
      const gap = merged[i + 1]!.draftStart - merged[i]!.draftEnd;
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    const a = merged[bestIdx]!;
    const b = merged[bestIdx + 1]!;
    a.liveEnd = Math.max(a.liveEnd, b.liveEnd);
    a.draftEnd = Math.max(a.draftEnd, b.draftEnd);
    merged.splice(bestIdx + 1, 1);
  }

  // 6. Render cropped, aligned WebP hunks
  const hunks: VisualDiffHunkDto[] = [];
  let prevDraftEnd = 0;

  for (let i = 0; i < merged.length; i++) {
    const s = merged[i]!;
    const rawDraftH = Math.max(1, s.draftEnd - s.draftStart);
    const rawLiveH = Math.max(1, s.liveEnd - s.liveStart);
    const draftCropH = Math.min(rawDraftH, MAX_HUNK_HEIGHT);
    const liveCropH = Math.min(rawLiveH, MAX_HUNK_HEIGHT);
    const alignedH = Math.max(draftCropH, liveCropH);

    const clampedSpan: HunkSpan = {
      liveStart: s.liveStart,
      liveEnd: s.liveStart + liveCropH,
      draftStart: s.draftStart,
      draftEnd: s.draftStart + draftCropH,
    };

    const { cropX, cropWidth } = computeHorizontalCrop(liveImg, draftImg, clampedSpan);
    const [draftUrl, liveUrl] = await Promise.all([
      cropAndPadWebp(draftBuf, cropX, clampedSpan.draftStart, cropWidth, draftCropH, alignedH),
      cropAndPadWebp(liveBuf, cropX, clampedSpan.liveStart, cropWidth, liveCropH, alignedH),
    ]);

    const hunkHighlights = remapHighlights(
      highlights,
      width,
      hDraft,
      cropX,
      clampedSpan.draftStart,
      cropWidth,
      alignedH,
    );

    const unchangedBeforePx = Math.max(0, clampedSpan.draftStart - prevDraftEnd);
    prevDraftEnd = clampedSpan.draftEnd;

    hunks.push({
      id: `hunk-${i}`,
      draftScreenshotDataUrl: draftUrl,
      liveScreenshotDataUrl: liveUrl,
      highlights: hunkHighlights,
      width: cropWidth,
      height: alignedH,
      draftCropY: clampedSpan.draftStart,
      draftCropHeight: draftCropH,
      liveCropY: clampedSpan.liveStart,
      liveCropHeight: liveCropH,
      cropX,
      cropWidth,
      unchangedBeforePx,
    });
  }

  const unchangedAfterPx = Math.max(0, hDraft - prevDraftEnd);
  const firstHunk = hunks[0]!;

  return {
    draftScreenshotDataUrl: firstHunk.draftScreenshotDataUrl,
    liveScreenshotDataUrl: firstHunk.liveScreenshotDataUrl,
    highlights: firstHunk.highlights,
    width: firstHunk.width,
    height: firstHunk.height,
    hunks,
    unchangedAfterPx,
    identical: false,
    fullWidth: width,
    fullHeight: hDraft,
    hasFullPage: true,
  };
}
