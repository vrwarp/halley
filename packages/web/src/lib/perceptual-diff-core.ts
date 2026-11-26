import type { VisualDiffHighlightDto } from '@halley/shared';

export const PERCEPTUAL_THRESHOLD = 0.12;
export const MAX_YIQ_DELTA = 35215 * PERCEPTUAL_THRESHOLD * PERCEPTUAL_THRESHOLD;
export const FAST_EQUAL_CHANNEL_TOLERANCE = 6;
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

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface PlannedHunk {
  id: string;
  draftCropY: number;
  draftCropHeight: number;
  liveCropY?: number;
  liveCropHeight?: number;
  cropX: number;
  cropWidth: number;
  alignedHeight: number;
  unchangedBeforePx: number;
  highlights: VisualDiffHighlightDto[];
}

export interface PerceptualDiffPlan {
  identical: boolean;
  hunks: PlannedHunk[];
  unchangedAfterPx: number;
  fullWidth: number;
  fullHeight: number;
  alignedFullHeight: number;
  hasFullPage: boolean;
  fullHighlights: VisualDiffHighlightDto[];
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

function blendOverWhite(c: number, a: number): number {
  return 255 + ((c - 255) * a) / 255;
}

/**
 * Kotsarenko & Ramos (2010) YIQ NTSC perceptual color difference.
 * Returns signed squared delta (sign matches brightness delta dy so AA
 * checks can distinguish darker vs brighter neighbors).
 */
export function perceptualColorDelta(
  img1: Uint8ClampedArray | Uint8Array,
  img2: Uint8ClampedArray | Uint8Array,
  k1: number,
  k2: number,
  yOnly = false,
): number {
  let r1 = img1[k1]!;
  let g1 = img1[k1 + 1]!;
  let b1 = img1[k1 + 2]!;
  const a1 = img1[k1 + 3]!;

  let r2 = img2[k2]!;
  let g2 = img2[k2 + 1]!;
  let b2 = img2[k2 + 2]!;
  const a2 = img2[k2 + 3]!;

  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;

  if (a1 < 255) {
    r1 = blendOverWhite(r1, a1);
    g1 = blendOverWhite(g1, a1);
    b1 = blendOverWhite(b1, a1);
  }
  if (a2 < 255) {
    r2 = blendOverWhite(r2, a2);
    g2 = blendOverWhite(g2, a2);
    b2 = blendOverWhite(b2, a2);
  }

  const y1 = r1 * 0.29889531 + g1 * 0.58662247 + b1 * 0.11448223;
  const y2 = r2 * 0.29889531 + g2 * 0.58662247 + b2 * 0.11448223;
  const dy = y1 - y2;
  if (yOnly) return dy;

  const i1 = r1 * 0.59597799 - g1 * 0.2741761 - b1 * 0.32180189;
  const i2 = r2 * 0.59597799 - g2 * 0.2741761 - b2 * 0.32180189;
  const q1 = r1 * 0.21147017 - g1 * 0.52261711 + b1 * 0.31114694;
  const q2 = r2 * 0.21147017 - g2 * 0.52261711 + b2 * 0.31114694;

  const di = i1 - i2;
  const dq = q1 - q2;
  const delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
  return dy > 0 ? -delta : delta;
}

function hasManySiblings(
  img: Uint8ClampedArray | Uint8Array,
  x1: number,
  y1: number,
  width: number,
  height: number,
): boolean {
  const x0 = Math.max(x1 - 1, 0);
  const y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1);
  const y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;

  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const pos2 = (y * width + x) * 4;
      if (
        img[pos] === img[pos2] &&
        img[pos + 1] === img[pos2 + 1] &&
        img[pos + 2] === img[pos2 + 2] &&
        img[pos + 3] === img[pos2 + 3]
      ) {
        zeroes += 1;
        if (zeroes > 2) return true;
      }
    }
  }
  return false;
}

/**
 * Vysniauskas (2009) 3x3 anti-aliasing detector adapted for arbitrary vertical alignment
 * (y1 in img1 paired with y2 in img2).
 */
export function isAntiAliased(
  img: RgbaImage,
  x1: number,
  y1: number,
  img2: RgbaImage,
  y2: number,
): boolean {
  const { width, height, data } = img;
  const x0 = Math.max(x1 - 1, 0);
  const y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1);
  const y2Bound = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2Bound ? 1 : 0;
  let min = 0;
  let max = 0;
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;

  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2Bound; y++) {
      if (x === x1 && y === y1) continue;
      const delta = perceptualColorDelta(data, data, pos, (y * width + x) * 4, true);
      if (delta === 0) {
        zeroes += 1;
        if (zeroes > 2) return false;
      } else if (delta < min) {
        min = delta;
        minX = x;
        minY = y;
      } else if (delta > max) {
        max = delta;
        maxX = x;
        maxY = y;
      }
    }
  }

  if (min === 0 || max === 0) return false;

  const minY2 = Math.max(0, Math.min(img2.height - 1, y2 + (minY - y1)));
  const maxY2 = Math.max(0, Math.min(img2.height - 1, y2 + (maxY - y1)));

  return (
    (hasManySiblings(data, minX, minY, width, height) &&
      hasManySiblings(img2.data, minX, minY2, img2.width, img2.height)) ||
    (hasManySiblings(data, maxX, maxY, width, height) &&
      hasManySiblings(img2.data, maxX, maxY2, img2.width, img2.height))
  );
}

/**
 * Returns true if pixel (x, yA) in imgA and (x, yB) in imgB differ perceptually
 * (exceeding YIQ threshold and not an anti-aliased edge pixel).
 */
export function isPerceptualPixelDiff(
  imgA: RgbaImage,
  imgB: RgbaImage,
  x: number,
  yA: number,
  yB: number,
  maxDelta = MAX_YIQ_DELTA,
): boolean {
  const kA = (yA * imgA.width + x) * 4;
  const kB = (yB * imgB.width + x) * 4;
  const dA = imgA.data;
  const dB = imgB.data;

  // Fast path: skip near-identical RGB/A pixels without floating-point YIQ math
  if (
    Math.abs(dA[kA]! - dB[kB]!) <= FAST_EQUAL_CHANNEL_TOLERANCE &&
    Math.abs(dA[kA + 1]! - dB[kB + 1]!) <= FAST_EQUAL_CHANNEL_TOLERANCE &&
    Math.abs(dA[kA + 2]! - dB[kB + 2]!) <= FAST_EQUAL_CHANNEL_TOLERANCE &&
    Math.abs(dA[kA + 3]! - dB[kB + 3]!) <= FAST_EQUAL_CHANNEL_TOLERANCE
  ) {
    return false;
  }

  const delta = perceptualColorDelta(dA, dB, kA, kB, false);
  if (Math.abs(delta) <= maxDelta) {
    return false;
  }

  if (isAntiAliased(imgA, x, yA, imgB, yB) || isAntiAliased(imgB, x, yB, imgA, yA)) {
    return false;
  }

  return true;
}

function rowsMatchPerceptual(
  live: RgbaImage,
  draft: RgbaImage,
  yL: number,
  yD: number,
  maxNoisePixels = MAX_NOISE_PIXELS_PER_ROW,
): boolean {
  const width = live.width;
  let bad = 0;
  for (let x = 0; x < width; x++) {
    if (isPerceptualPixelDiff(live, draft, x, yL, yD)) {
      bad += 1;
      if (bad > maxNoisePixels) return false;
    }
  }
  return true;
}

function computeRowSignatures(img: RgbaImage, startY: number, endY: number): {
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

      // Quantize to 4 bits per channel so minor WebP/AA jitter hashes identically
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

function findMiddleUnchangedBands(
  live: RgbaImage,
  draft: RgbaImage,
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

  const liveSig = computeRowSignatures(live, liveStart, liveEnd);
  const draftSig = computeRowSignatures(draft, draftStart, draftEnd);

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
    if (!rowsMatchPerceptual(live, draft, anchor.liveY, anchor.draftY)) continue;

    let lTop = anchor.liveY;
    let dTop = anchor.draftY;
    while (lTop > curLiveMin && dTop > curDraftMin && rowsMatchPerceptual(live, draft, lTop - 1, dTop - 1)) {
      lTop -= 1;
      dTop -= 1;
    }

    let lBot = anchor.liveY + 1;
    let dBot = anchor.draftY + 1;
    while (lBot < liveEnd && dBot < draftEnd && rowsMatchPerceptual(live, draft, lBot, dBot)) {
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

  // Fallback scan for equal-offset unchanged bands in remaining large gaps
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
        if (rowsMatchPerceptual(live, draft, lY, dY)) {
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
  live: RgbaImage,
  draft: RgbaImage,
  span: HunkSpan,
): { cropX: number; cropWidth: number } {
  const width = draft.width;
  if (width < DESKTOP_TRIM_THRESHOLD_WIDTH) {
    return { cropX: 0, cropWidth: width };
  }

  const liveH = Math.max(0, span.liveEnd - span.liveStart);
  const draftH = Math.max(0, span.draftEnd - span.draftStart);
  const overlapH = Math.min(liveH, draftH);

  let minX = width;
  let maxX = -1;

  for (let r = 0; r < overlapH; r++) {
    const yL = span.liveStart + r;
    const yD = span.draftStart + r;
    for (let x = 0; x < width; x++) {
      if (isPerceptualPixelDiff(live, draft, x, yL, yD)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }

  if (liveH !== draftH) {
    const taller = draftH > liveH ? draft : live;
    const extraStart = (draftH > liveH ? span.draftStart : span.liveStart) + overlapH;
    const extraEnd = draftH > liveH ? span.draftEnd : span.liveEnd;
    const rowBytes = width * 4;
    for (let y = extraStart; y < extraEnd; y++) {
      const off = y * rowBytes;
      const bgR = taller.data[off]!;
      const bgG = taller.data[off + 1]!;
      const bgB = taller.data[off + 2]!;
      for (let x = 0; x < width; x++) {
        const i = off + x * 4;
        if (
          Math.abs(taller.data[i]! - bgR) > 14 ||
          Math.abs(taller.data[i + 1]! - bgG) > 14 ||
          Math.abs(taller.data[i + 2]! - bgB) > 14
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

export function remapHighlights(
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

/**
 * Plans cropped hunks and full-page alignment using YIQ perceptual diffing + 3x3 AA detection.
 */
export function computePerceptualDiffPlan(
  draft: RgbaImage,
  live: RgbaImage | null,
  highlights: VisualDiffHighlightDto[],
): PerceptualDiffPlan {
  const width = draft.width;
  const hDraft = draft.height;

  // Draft-only fallback (no Live image or mismatched width): top 0..1400px preview
  if (!live || live.width !== width) {
    const previewH = Math.min(hDraft, DRAFT_ONLY_PREVIEW_HEIGHT);
    const unchangedAfterPx = Math.max(0, hDraft - previewH);
    const hunk: PlannedHunk = {
      id: 'hunk-0',
      draftCropY: 0,
      draftCropHeight: previewH,
      cropX: 0,
      cropWidth: width,
      alignedHeight: previewH,
      unchangedBeforePx: 0,
      highlights: remapHighlights(highlights, width, hDraft, 0, 0, width, previewH),
    };
    return {
      identical: false,
      hunks: [hunk],
      unchangedAfterPx,
      fullWidth: width,
      fullHeight: hDraft,
      alignedFullHeight: hDraft,
      hasFullPage: unchangedAfterPx > 0,
      fullHighlights: highlights,
    };
  }

  const hLive = live.height;
  const alignedFullHeight = Math.max(hDraft, hLive);
  const fullHighlights = remapHighlights(highlights, width, hDraft, 0, 0, width, alignedFullHeight);
  const minH = Math.min(hLive, hDraft);

  // 1. Top-down perceptual trim
  let topTrim = 0;
  while (topTrim < minH && rowsMatchPerceptual(live, draft, topTrim, topTrim)) {
    topTrim += 1;
  }

  if (topTrim === hLive && hLive === hDraft) {
    return {
      identical: true,
      hunks: [],
      unchangedAfterPx: 0,
      fullWidth: width,
      fullHeight: hDraft,
      alignedFullHeight,
      hasFullPage: true,
      fullHighlights,
    };
  }

  // 2. Bottom-up perceptual trim (resilient to height shifts)
  let bottomTrim = 0;
  const maxBottom = Math.min(hLive - topTrim, hDraft - topTrim);
  while (
    bottomTrim < maxBottom &&
    rowsMatchPerceptual(live, draft, hLive - 1 - bottomTrim, hDraft - 1 - bottomTrim)
  ) {
    bottomTrim += 1;
  }

  const activeLiveEnd = hLive - bottomTrim;
  const activeDraftEnd = hDraft - bottomTrim;

  // 3. Anchored middle-band alignment for multi-hunk splitting
  const middleBands = findMiddleUnchangedBands(
    live,
    draft,
    topTrim,
    activeLiveEnd,
    topTrim,
    activeDraftEnd,
  );

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

  if (rawSpans.length === 0) {
    rawSpans.push({
      liveStart: topTrim,
      liveEnd: Math.max(topTrim + 1, activeLiveEnd),
      draftStart: topTrim,
      draftEnd: Math.max(topTrim + 1, activeDraftEnd),
    });
  }

  // 4. Pad vertically and merge overlapping / tiny-gap intervals
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

  // 5. Coalesce to MAX_HUNKS_PER_PAGE
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

  // 6. Plan each hunk's X/Y crop, aligned height, and remapped highlights
  const hunks: PlannedHunk[] = [];
  let prevDraftEnd = 0;

  for (let i = 0; i < merged.length; i++) {
    const s = merged[i]!;
    const draftCropH = Math.min(Math.max(1, s.draftEnd - s.draftStart), MAX_HUNK_HEIGHT);
    const liveCropH = Math.min(Math.max(1, s.liveEnd - s.liveStart), MAX_HUNK_HEIGHT);
    const alignedHeight = Math.max(draftCropH, liveCropH);

    const clampedSpan: HunkSpan = {
      liveStart: s.liveStart,
      liveEnd: s.liveStart + liveCropH,
      draftStart: s.draftStart,
      draftEnd: s.draftStart + draftCropH,
    };

    const { cropX, cropWidth } = computeHorizontalCrop(live, draft, clampedSpan);
    const unchangedBeforePx = Math.max(0, clampedSpan.draftStart - prevDraftEnd);
    prevDraftEnd = clampedSpan.draftEnd;

    hunks.push({
      id: `hunk-${i}`,
      draftCropY: clampedSpan.draftStart,
      draftCropHeight: draftCropH,
      liveCropY: clampedSpan.liveStart,
      liveCropHeight: liveCropH,
      cropX,
      cropWidth,
      alignedHeight,
      unchangedBeforePx,
      highlights: remapHighlights(
        highlights,
        width,
        hDraft,
        cropX,
        clampedSpan.draftStart,
        cropWidth,
        alignedHeight,
      ),
    });
  }

  return {
    identical: false,
    hunks,
    unchangedAfterPx: Math.max(0, hDraft - prevDraftEnd),
    fullWidth: width,
    fullHeight: hDraft,
    alignedFullHeight,
    hasFullPage: true,
    fullHighlights,
  };
}

/**
 * Renders a visual perceptual diff RGBA buffer:
 * - Unchanged / anti-aliased pixels: dimmed Draft (~25% opacity over white) for page context
 * - Perceptually changed pixels (and added/removed height rows): crisp rose (#E11D48)
 */
export function renderPerceptualDiffRgba(
  draft: RgbaImage,
  live: RgbaImage,
  opts: {
    cropX: number;
    cropWidth: number;
    draftCropY: number;
    draftCropHeight: number;
    liveCropY: number;
    liveCropHeight: number;
    alignedHeight: number;
  },
): Uint8ClampedArray {
  const { cropX, cropWidth, draftCropY, draftCropHeight, liveCropY, liveCropHeight, alignedHeight } =
    opts;
  const out = new Uint8ClampedArray(cropWidth * alignedHeight * 4);
  const overlapH = Math.min(draftCropHeight, liveCropHeight);

  for (let row = 0; row < alignedHeight; row++) {
    const yD = draftCropY + row;
    const yL = liveCropY + row;
    const inDraft = row < draftCropHeight && yD < draft.height;
    const inLive = row < liveCropHeight && yL < live.height;

    for (let col = 0; col < cropWidth; col++) {
      const x = cropX + col;
      const outIdx = (row * cropWidth + col) * 4;

      if (row < overlapH && inDraft && inLive) {
        if (isPerceptualPixelDiff(live, draft, x, yL, yD)) {
          // Crisp rose/magenta (#E11D48)
          out[outIdx] = 225;
          out[outIdx + 1] = 29;
          out[outIdx + 2] = 72;
          out[outIdx + 3] = 255;
        } else {
          // Dimmed (~25% opacity) softly desaturated Draft over white for calm context
          const dIdx = (yD * draft.width + x) * 4;
          const r = draft.data[dIdx]!;
          const g = draft.data[dIdx + 1]!;
          const b = draft.data[dIdx + 2]!;
          const lum = r * 0.299 + g * 0.587 + b * 0.114;
          const sr = r * 0.5 + lum * 0.5;
          const sg = g * 0.5 + lum * 0.5;
          const sb = b * 0.5 + lum * 0.5;
          out[outIdx] = Math.round(255 * 0.75 + sr * 0.25);
          out[outIdx + 1] = Math.round(255 * 0.75 + sg * 0.25);
          out[outIdx + 2] = Math.round(255 * 0.75 + sb * 0.25);
          out[outIdx + 3] = 255;
        }
      } else if (inDraft) {
        // Added height in Draft: highlight non-background pixels in rose, dimmed background
        const dIdx = (yD * draft.width + x) * 4;
        const r = draft.data[dIdx]!;
        const g = draft.data[dIdx + 1]!;
        const b = draft.data[dIdx + 2]!;
        const edgeIdx = (yD * draft.width + cropX) * 4;
        const isContent =
          Math.abs(r - draft.data[edgeIdx]!) > 14 ||
          Math.abs(g - draft.data[edgeIdx + 1]!) > 14 ||
          Math.abs(b - draft.data[edgeIdx + 2]!) > 14;
        if (isContent) {
          out[outIdx] = 225;
          out[outIdx + 1] = 29;
          out[outIdx + 2] = 72;
          out[outIdx + 3] = 255;
        } else {
          out[outIdx] = 254;
          out[outIdx + 1] = 242;
          out[outIdx + 2] = 242;
          out[outIdx + 3] = 255;
        }
      } else {
        // Removed height (Live was taller than Draft): soft rose-tinted band
        out[outIdx] = 254;
        out[outIdx + 1] = 226;
        out[outIdx + 2] = 226;
        out[outIdx + 3] = 255;
      }
    }
  }

  return out;
}
