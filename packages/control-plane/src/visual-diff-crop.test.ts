import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  buildVisualDiffShot,
  DRAFT_ONLY_PREVIEW_HEIGHT,
  MAX_HUNKS_PER_PAGE,
  MIN_DESKTOP_CROP_WIDTH,
  PADDING_Y,
} from './visual-diff-crop.js';

interface RectDraw {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Generates a realistic synthetic webpage PNG with horizontal structure (distinct
 * section stripes/bars every 40px) plus optional custom rectangles.
 */
async function makePagePng(
  width: number,
  height: number,
  opts?: {
    rects?: RectDraw[];
    insertGapAtY?: { y: number; addedHeight: number };
    noiseOffset?: number;
  },
): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 4);
  const noise = opts?.noiseOffset ?? 0;
  const gap = opts?.insertGapAtY;

  for (let y = 0; y < height; y++) {
    // Map y back to base coordinate so sections below an inserted gap remain identical
    let baseY = y;
    let inGap = false;
    if (gap) {
      if (y >= gap.y && y < gap.y + gap.addedHeight) {
        inGap = true;
      } else if (y >= gap.y + gap.addedHeight) {
        baseY = y - gap.addedHeight;
      }
    }

    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOff + x * 4;
      let r = 248;
      let g = 246;
      let b = 242;

      if (inGap && gap) {
        // Distinct inserted paragraph block
        if (x >= 120 && x < Math.min(width - 40, 520) && (y - gap.y) % 24 < 12) {
          r = 40;
          g = 90;
          b = 180;
        }
      } else {
        // Deterministic structured content pattern unique per y band
        const band = Math.floor(baseY / 16);
        const barStart = 32 + ((band * 37) % Math.max(40, width - 180));
        const barEnd = Math.min(width - 24, barStart + 110 + ((band * 19) % 70));
        if (x >= barStart && x < barEnd && baseY % 16 < 10) {
          r = (35 + band * 17) % 200;
          g = (50 + band * 29) % 200;
          b = (70 + band * 41) % 200;
        }
      }

      buf[idx] = Math.max(0, Math.min(255, r + noise));
      buf[idx + 1] = Math.max(0, Math.min(255, g + noise));
      buf[idx + 2] = Math.max(0, Math.min(255, b + noise));
      buf[idx + 3] = 255;
    }
  }

  for (const rect of opts?.rects ?? []) {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(width, rect.x + rect.w);
    const y1 = Math.min(height, rect.y + rect.h);
    for (let y = y0; y < y1; y++) {
      const rowOff = y * width * 4;
      for (let x = x0; x < x1; x++) {
        const idx = rowOff + x * 4;
        buf[idx] = rect.r;
        buf[idx + 1] = rect.g;
        buf[idx + 2] = rect.b;
        buf[idx + 3] = 255;
      }
    }
  }

  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

describe('buildVisualDiffShot (visual-diff-crop)', () => {
  it('trims top/bottom and desktop left/right margins with padding & 640px min width', async () => {
    const liveBuf = await makePagePng(1280, 3000);
    const draftBuf = await makePagePng(1280, 3000, {
      rects: [{ x: 760, y: 1400, w: 180, h: 100, r: 220, g: 40, b: 40 }],
    });

    const shot = await buildVisualDiffShot({
      draftBuf,
      liveBuf,
      highlights: [
        {
          x: (760 / 1280) * 100,
          y: (1400 / 3000) * 100,
          width: (180 / 1280) * 100,
          height: (100 / 3000) * 100,
          kind: 'draft',
          file: 'src/pages/about.astro',
        },
      ],
      fallbackWidth: 1280,
      fallbackHeight: 3000,
      mode: 'cropped',
    });

    expect(shot.identical).toBe(false);
    expect(shot.hasFullPage).toBe(true);
    expect(shot.hunks).toHaveLength(1);

    const hunk = shot.hunks![0]!;
    expect(hunk.draftCropY).toBe(1400 - PADDING_Y);
    expect(hunk.draftCropHeight).toBe(100 + PADDING_Y * 2);
    expect(hunk.unchangedBeforePx).toBe(1400 - PADDING_Y);
    expect(shot.unchangedAfterPx).toBe(3000 - (1500 + PADDING_Y));
    // Desktop X trim should enforce MIN_DESKTOP_CROP_WIDTH (640px) and not keep full 1280px
    expect(hunk.cropWidth).toBe(MIN_DESKTOP_CROP_WIDTH);
    expect(hunk.cropX).toBeGreaterThan(0);
    expect(hunk.draftScreenshotDataUrl).toContain('data:image/webp;base64,');
    expect(hunk.liveScreenshotDataUrl).toContain('data:image/webp;base64,');
    // Highlight remapped into hunk local coordinates
    expect(hunk.highlights).toHaveLength(1);
    expect(hunk.highlights[0]!.y).toBeGreaterThan(20);
    expect(hunk.highlights[0]!.y).toBeLessThan(45);
  });

  it('keeps full 390px width on mobile while trimming unchanged top and bottom', async () => {
    const liveBuf = await makePagePng(390, 2800);
    const draftBuf = await makePagePng(390, 2800, {
      rects: [{ x: 100, y: 1200, w: 120, h: 80, r: 20, g: 160, b: 80 }],
    });

    const shot = await buildVisualDiffShot({
      draftBuf,
      liveBuf,
      highlights: [],
      fallbackWidth: 390,
      fallbackHeight: 2800,
      mode: 'cropped',
    });

    expect(shot.hunks).toHaveLength(1);
    const hunk = shot.hunks![0]!;
    expect(hunk.cropX).toBe(0);
    expect(hunk.cropWidth).toBe(390);
    expect(hunk.unchangedBeforePx).toBe(1200 - PADDING_Y);
    expect(shot.unchangedAfterPx).toBe(2800 - (1280 + PADDING_Y));
  });

  it('handles height-shifting edits cleanly (trims unchanged footer and bottom-pads shorter hunk)', async () => {
    const liveBuf = await makePagePng(390, 2400);
    // Insert +140px at y=1000 -> Draft is 2540px tall, bottom 1400px is identical to Live's bottom 1400px
    const draftBuf = await makePagePng(390, 2540, {
      insertGapAtY: { y: 1000, addedHeight: 140 },
    });

    const shot = await buildVisualDiffShot({
      draftBuf,
      liveBuf,
      highlights: [],
      fallbackWidth: 390,
      fallbackHeight: 2540,
      mode: 'cropped',
    });

    expect(shot.identical).toBe(false);
    expect(shot.hunks).toHaveLength(1);
    const hunk = shot.hunks![0]!;
    expect(hunk.unchangedBeforePx).toBe(1000 - PADDING_Y);
    expect(shot.unchangedAfterPx).toBe(2540 - (1140 + PADDING_Y));
    expect(hunk.draftCropHeight).toBe(hunk.liveCropHeight! + 140);
    // Aligned output height equals max(draftCropHeight, liveCropHeight)
    expect(hunk.height).toBe(hunk.draftCropHeight);

    const liveMeta = await sharp(
      Buffer.from(hunk.liveScreenshotDataUrl!.split(',')[1]!, 'base64'),
    ).metadata();
    const draftMeta = await sharp(
      Buffer.from(hunk.draftScreenshotDataUrl.split(',')[1]!, 'base64'),
    ).metadata();
    expect(liveMeta.height).toBe(draftMeta.height);
    expect(liveMeta.width).toBe(draftMeta.width);
  });

  it('splits distant edits into 2 hunks and re-aligns Hunk 2 after an upper height shift', async () => {
    const liveBuf = await makePagePng(390, 3200);
    // Upper +100px insertion at y=300 AND second edit at Live y=2600 (Draft y=2700)
    const draftBuf = await makePagePng(390, 3300, {
      insertGapAtY: { y: 300, addedHeight: 100 },
      rects: [{ x: 40, y: 2700, w: 200, h: 80, r: 220, g: 30, b: 30 }],
    });

    const shot = await buildVisualDiffShot({
      draftBuf,
      liveBuf,
      highlights: [],
      fallbackWidth: 390,
      fallbackHeight: 3300,
      mode: 'cropped',
    });

    expect(shot.hunks).toHaveLength(2);
    const [h0, h1] = shot.hunks!;
    expect(h0!.draftCropY).toBe(300 - PADDING_Y);
    expect(h0!.liveCropY).toBe(300 - PADDING_Y);
    // Hunk 2 is vertically re-aligned by +100px!
    expect(h1!.draftCropY - h1!.liveCropY!).toBe(100);
    expect(h1!.unchangedBeforePx).toBeGreaterThan(1800);
  });

  it('returns identical: true when pages match within anti-aliasing noise tolerance', async () => {
    const liveBuf = await makePagePng(390, 1200);
    const draftBuf = await makePagePng(390, 1200, { noiseOffset: 5 });

    const shot = await buildVisualDiffShot({
      draftBuf,
      liveBuf,
      highlights: [],
      fallbackWidth: 390,
      fallbackHeight: 1200,
      mode: 'cropped',
    });

    expect(shot.identical).toBe(true);
    expect(shot.hunks).toEqual([]);
    expect(shot.hasFullPage).toBe(true);
  });

  it('crops Draft-only pages to top 1400px preview with hasFullPage=true', async () => {
    const draftBuf = await makePagePng(390, 3000);
    const shot = await buildVisualDiffShot({
      draftBuf,
      highlights: [],
      fallbackWidth: 390,
      fallbackHeight: 3000,
      mode: 'cropped',
    });

    expect(shot.identical).toBe(false);
    expect(shot.hasFullPage).toBe(true);
    expect(shot.hunks).toHaveLength(1);
    expect(shot.hunks![0]!.height).toBe(DRAFT_ONLY_PREVIEW_HEIGHT);
    expect(shot.unchangedAfterPx).toBe(3000 - DRAFT_ONLY_PREVIEW_HEIGHT);
  });

  it('coalesces > 4 distant edits down to MAX_HUNKS_PER_PAGE (4)', async () => {
    const liveBuf = await makePagePng(390, 4800);
    const draftBuf = await makePagePng(390, 4800, {
      rects: [
        { x: 40, y: 200, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 1000, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 1800, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 2600, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 3400, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 4200, w: 120, h: 40, r: 220, g: 20, b: 20 },
      ],
    });

    const shot = await buildVisualDiffShot({
      draftBuf,
      liveBuf,
      highlights: [],
      fallbackWidth: 390,
      fallbackHeight: 4800,
      mode: 'cropped',
    });

    expect(shot.hunks!.length).toBeLessThanOrEqual(MAX_HUNKS_PER_PAGE);
    expect(shot.hunks!.length).toBeGreaterThanOrEqual(2);
  });

  it('supports mode="full" returning full aligned Live & Draft WebP images', async () => {
    const liveBuf = await makePagePng(390, 1200);
    const draftBuf = await makePagePng(390, 1300, {
      insertGapAtY: { y: 400, addedHeight: 100 },
    });

    const shot = await buildVisualDiffShot({
      draftBuf,
      liveBuf,
      highlights: [],
      fallbackWidth: 390,
      fallbackHeight: 1300,
      mode: 'full',
    });

    expect(shot.hunks).toBeUndefined();
    expect(shot.width).toBe(390);
    expect(shot.height).toBe(1300);
    expect(shot.draftScreenshotDataUrl).toContain('data:image/webp;base64,');
    expect(shot.liveScreenshotDataUrl).toContain('data:image/webp;base64,');
  });
});
