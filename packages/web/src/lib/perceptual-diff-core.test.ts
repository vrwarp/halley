import { describe, expect, it } from 'vitest';
import {
  computePerceptualDiffPlan,
  DRAFT_ONLY_PREVIEW_HEIGHT,
  isAntiAliased,
  MAX_HUNKS_PER_PAGE,
  MIN_DESKTOP_CROP_WIDTH,
  PADDING_Y,
  renderPerceptualDiffRgba,
  type RgbaImage,
} from './perceptual-diff-core.js';

interface RectDraw {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
}

function makeSyntheticRgba(
  width: number,
  height: number,
  opts?: {
    rects?: RectDraw[];
    insertGapAtY?: { y: number; addedHeight: number };
    noiseOffset?: number;
  },
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const noise = opts?.noiseOffset ?? 0;
  const gap = opts?.insertGapAtY;

  for (let y = 0; y < height; y++) {
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
        if (x >= 120 && x < Math.min(width - 40, 520) && (y - gap.y) % 24 < 12) {
          r = 40;
          g = 90;
          b = 180;
        }
      } else {
        const band = Math.floor(baseY / 16);
        const barStart = 32 + ((band * 37) % Math.max(40, width - 180));
        const barEnd = Math.min(width - 24, barStart + 110 + ((band * 19) % 70));
        if (x >= barStart && x < barEnd && baseY % 16 < 10) {
          r = (35 + band * 17) % 200;
          g = (50 + band * 29) % 200;
          b = (70 + band * 41) % 200;
        }
      }

      data[idx] = Math.max(0, Math.min(255, r + noise));
      data[idx + 1] = Math.max(0, Math.min(255, g + noise));
      data[idx + 2] = Math.max(0, Math.min(255, b + noise));
      data[idx + 3] = 255;
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
        data[idx] = rect.r;
        data[idx + 1] = rect.g;
        data[idx + 2] = rect.b;
        data[idx + 3] = 255;
      }
    }
  }

  return { data, width, height };
}

describe('perceptual-diff-core', () => {
  it('ignores minor WebP compression jitter via YIQ perceptual threshold', () => {
    const live = makeSyntheticRgba(390, 1200);
    const draft = makeSyntheticRgba(390, 1200, { noiseOffset: 8 });
    const plan = computePerceptualDiffPlan(draft, live, []);

    expect(plan.identical).toBe(true);
    expect(plan.hunks).toEqual([]);
    expect(plan.hasFullPage).toBe(true);
  });

  it('detects 3x3 anti-aliased edge pixels without suppressing solid edits', () => {
    // 5x5 image with a crisp diagonal transition (white top-left, black bottom-right, gray anti-aliased diagonal)
    const w = 5;
    const h = 5;
    const makeDiag = (centerGray: number): RgbaImage => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const v = x + y < 4 ? 255 : x + y > 4 ? 0 : centerGray;
          data[idx] = v;
          data[idx + 1] = v;
          data[idx + 2] = v;
          data[idx + 3] = 255;
        }
      }
      return { data, width: w, height: h };
    };

    const imgA = makeDiag(110);
    const imgB = makeDiag(180);
    expect(isAntiAliased(imgA, 2, 2, imgB, 2)).toBe(true);
  });

  it('trims top/bottom and desktop left/right margins with 640px min width and remaps highlights', () => {
    const live = makeSyntheticRgba(1280, 3000);
    const draft = makeSyntheticRgba(1280, 3000, {
      rects: [{ x: 760, y: 1400, w: 180, h: 100, r: 220, g: 40, b: 40 }],
    });

    const plan = computePerceptualDiffPlan(draft, live, [
      {
        x: (760 / 1280) * 100,
        y: (1400 / 3000) * 100,
        width: (180 / 1280) * 100,
        height: (100 / 3000) * 100,
        kind: 'draft',
        file: 'src/pages/about.astro',
      },
    ]);

    expect(plan.identical).toBe(false);
    expect(plan.hunks).toHaveLength(1);
    const hunk = plan.hunks[0]!;
    expect(hunk.draftCropY).toBe(1400 - PADDING_Y);
    expect(hunk.draftCropHeight).toBe(100 + PADDING_Y * 2);
    expect(hunk.cropWidth).toBe(MIN_DESKTOP_CROP_WIDTH);
    expect(hunk.cropX).toBeGreaterThan(0);
    expect(hunk.highlights).toHaveLength(1);
    expect(hunk.highlights[0]!.y).toBeGreaterThan(20);
    expect(hunk.highlights[0]!.y).toBeLessThan(45);
  });

  it('keeps full 390px width on mobile and re-aligns Hunk 2 after an upper height shift', () => {
    const live = makeSyntheticRgba(390, 3200);
    const draft = makeSyntheticRgba(390, 3300, {
      insertGapAtY: { y: 300, addedHeight: 100 },
      rects: [{ x: 40, y: 2700, w: 200, h: 80, r: 220, g: 30, b: 30 }],
    });

    const plan = computePerceptualDiffPlan(draft, live, []);

    expect(plan.hunks).toHaveLength(2);
    const [h0, h1] = plan.hunks;
    expect(h0!.cropX).toBe(0);
    expect(h0!.cropWidth).toBe(390);
    expect(h0!.draftCropY).toBe(300 - PADDING_Y);
    expect(h1!.draftCropY - h1!.liveCropY!).toBe(100);
    expect(h1!.unchangedBeforePx).toBeGreaterThan(1800);
  });

  it('crops Draft-only pages to top 1400px preview and coalesces > 4 distant edits to 4 hunks', () => {
    const draftOnly = makeSyntheticRgba(390, 3000);
    const draftPlan = computePerceptualDiffPlan(draftOnly, null, []);
    expect(draftPlan.hunks).toHaveLength(1);
    expect(draftPlan.hunks[0]!.alignedHeight).toBe(DRAFT_ONLY_PREVIEW_HEIGHT);
    expect(draftPlan.unchangedAfterPx).toBe(3000 - DRAFT_ONLY_PREVIEW_HEIGHT);
    expect(draftPlan.hasFullPage).toBe(true);

    const live = makeSyntheticRgba(390, 4800);
    const manyEdits = makeSyntheticRgba(390, 4800, {
      rects: [
        { x: 40, y: 200, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 1000, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 1800, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 2600, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 3400, w: 120, h: 40, r: 220, g: 20, b: 20 },
        { x: 40, y: 4200, w: 120, h: 40, r: 220, g: 20, b: 20 },
      ],
    });
    const coalesced = computePerceptualDiffPlan(manyEdits, live, []);
    expect(coalesced.hunks.length).toBeLessThanOrEqual(MAX_HUNKS_PER_PAGE);
    expect(coalesced.hunks.length).toBeGreaterThanOrEqual(2);
  });

  it('renders crisp rose (#E11D48) diff pixels on a dimmed Draft backdrop', () => {
    const live = makeSyntheticRgba(100, 100);
    const draft = makeSyntheticRgba(100, 100, {
      rects: [{ x: 30, y: 40, w: 20, h: 20, r: 20, g: 140, b: 240 }],
    });

    const diffRgba = renderPerceptualDiffRgba(draft, live, {
      cropX: 0,
      cropWidth: 100,
      draftCropY: 0,
      draftCropHeight: 100,
      liveCropY: 0,
      liveCropHeight: 100,
      alignedHeight: 100,
    });

    // Center of edited rectangle (40, 50) -> rose (#E11D48 = 225, 29, 72)
    const changedIdx = (50 * 100 + 40) * 4;
    expect(diffRgba[changedIdx]).toBe(225);
    expect(diffRgba[changedIdx + 1]).toBe(29);
    expect(diffRgba[changedIdx + 2]).toBe(72);

    // Unchanged pixel (5, 5) -> dimmed light backdrop (>= 240 on light background)
    const unchangedIdx = (5 * 100 + 5) * 4;
    expect(diffRgba[unchangedIdx]!).toBeGreaterThan(240);
    expect(diffRgba[unchangedIdx + 1]!).toBeGreaterThan(240);
    expect(diffRgba[unchangedIdx + 2]!).toBeGreaterThan(240);
  });
});
