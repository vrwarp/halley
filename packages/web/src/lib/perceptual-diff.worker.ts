/// <reference lib="webworker" />

import type { VisualDiffHighlightDto } from '@halley/shared';
import {
  computePerceptualDiffPlan,
  renderPerceptualDiffRgba,
  type RgbaImage,
} from './perceptual-diff-core.js';

export interface WorkerHunkOutput {
  id: string;
  draftBlob: Blob;
  liveBlob?: Blob;
  diffBlob?: Blob;
  highlights: VisualDiffHighlightDto[];
  width: number;
  height: number;
  draftCropY: number;
  draftCropHeight: number;
  liveCropY?: number;
  liveCropHeight?: number;
  cropX: number;
  cropWidth: number;
  unchangedBeforePx: number;
}

export type PerceptualWorkerRequest =
  | {
      id: number;
      kind: 'process_route';
      draftBlob: Blob;
      liveBlob?: Blob;
      highlights: VisualDiffHighlightDto[];
    }
  | {
      id: number;
      kind: 'render_full_diff';
      draftBlob: Blob;
      liveBlob: Blob;
    };

export type PerceptualWorkerResponse =
  | {
      id: number;
      kind: 'process_route';
      ok: true;
      identical: boolean;
      hunks: WorkerHunkOutput[];
      unchangedAfterPx: number;
      fullWidth: number;
      fullHeight: number;
      alignedFullHeight: number;
      hasFullPage: boolean;
      fullHighlights: VisualDiffHighlightDto[];
      fullDraftBlob?: Blob;
      fullLiveBlob?: Blob;
    }
  | {
      id: number;
      kind: 'render_full_diff';
      ok: true;
      diffBlob: Blob;
      width: number;
      height: number;
    }
  | {
      id: number;
      kind: 'error';
      ok: false;
      error: string;
    };

async function decodeBlobToRgba(blob: Blob): Promise<{ bitmap: ImageBitmap; rgba: RgbaImage }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error('OffscreenCanvas 2D context unavailable');
  }
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return {
    bitmap,
    rgba: {
      data: imageData.data,
      width: bitmap.width,
      height: bitmap.height,
    },
  };
}

async function encodeCanvasBlob(canvas: OffscreenCanvas): Promise<Blob> {
  try {
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.88 });
  } catch {
    return await canvas.convertToBlob({ type: 'image/png' });
  }
}

async function sliceAndPadBitmap(
  bitmap: ImageBitmap,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  alignedHeight: number,
): Promise<Blob> {
  const safeW = Math.max(1, cropWidth);
  const safeH = Math.max(1, cropHeight);
  const outH = Math.max(safeH, alignedHeight);
  const canvas = new OffscreenCanvas(safeW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  if (outH > safeH) {
    // Neutral stone-100 (#F5F5F4) bottom alignment canvas
    ctx.fillStyle = '#F5F5F4';
    ctx.fillRect(0, 0, safeW, outH);
  }
  ctx.drawImage(bitmap, cropX, cropY, safeW, safeH, 0, 0, safeW, safeH);
  if (outH > safeH) {
    // Subtle 1px stone-300 (#D6D3D1) hairline at the height-alignment boundary
    ctx.fillStyle = '#D6D3D1';
    ctx.fillRect(0, safeH, safeW, 1);
  }
  return encodeCanvasBlob(canvas);
}

async function rgbaToBlob(rgba: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  const clamped = new Uint8ClampedArray(rgba.length);
  clamped.set(rgba);
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  return encodeCanvasBlob(canvas);
}

self.onmessage = async (event: MessageEvent<PerceptualWorkerRequest>) => {
  const req = event.data;
  try {
    if (req.kind === 'process_route') {
      const draftDecoded = await decodeBlobToRgba(req.draftBlob);
      const liveDecoded = req.liveBlob ? await decodeBlobToRgba(req.liveBlob) : null;

      try {
        const plan = computePerceptualDiffPlan(
          draftDecoded.rgba,
          liveDecoded?.rgba ?? null,
          req.highlights,
        );

        const hunks: WorkerHunkOutput[] = [];
        for (const h of plan.hunks) {
          const draftSlice = await sliceAndPadBitmap(
            draftDecoded.bitmap,
            h.cropX,
            h.draftCropY,
            h.cropWidth,
            h.draftCropHeight,
            h.alignedHeight,
          );
          let liveSlice: Blob | undefined;
          let diffSlice: Blob | undefined;

          if (liveDecoded && h.liveCropY !== undefined && h.liveCropHeight !== undefined) {
            liveSlice = await sliceAndPadBitmap(
              liveDecoded.bitmap,
              h.cropX,
              h.liveCropY,
              h.cropWidth,
              h.liveCropHeight,
              h.alignedHeight,
            );
            const diffRgba = renderPerceptualDiffRgba(draftDecoded.rgba, liveDecoded.rgba, {
              cropX: h.cropX,
              cropWidth: h.cropWidth,
              draftCropY: h.draftCropY,
              draftCropHeight: h.draftCropHeight,
              liveCropY: h.liveCropY,
              liveCropHeight: h.liveCropHeight,
              alignedHeight: h.alignedHeight,
            });
            diffSlice = await rgbaToBlob(diffRgba, h.cropWidth, h.alignedHeight);
          }

          hunks.push({
            id: h.id,
            draftBlob: draftSlice,
            liveBlob: liveSlice,
            diffBlob: diffSlice,
            highlights: h.highlights,
            width: h.cropWidth,
            height: h.alignedHeight,
            draftCropY: h.draftCropY,
            draftCropHeight: h.draftCropHeight,
            liveCropY: h.liveCropY,
            liveCropHeight: h.liveCropHeight,
            cropX: h.cropX,
            cropWidth: h.cropWidth,
            unchangedBeforePx: h.unchangedBeforePx,
          });
        }

        // Only re-pad full-page images when Live & Draft have different heights
        let fullDraftBlob: Blob | undefined;
        let fullLiveBlob: Blob | undefined;
        if (
          liveDecoded &&
          liveDecoded.rgba.width === draftDecoded.rgba.width &&
          liveDecoded.rgba.height !== draftDecoded.rgba.height
        ) {
          const alignedH = plan.alignedFullHeight;
          fullDraftBlob = await sliceAndPadBitmap(
            draftDecoded.bitmap,
            0,
            0,
            draftDecoded.rgba.width,
            draftDecoded.rgba.height,
            alignedH,
          );
          fullLiveBlob = await sliceAndPadBitmap(
            liveDecoded.bitmap,
            0,
            0,
            liveDecoded.rgba.width,
            liveDecoded.rgba.height,
            alignedH,
          );
        }

        const resp: PerceptualWorkerResponse = {
          id: req.id,
          kind: 'process_route',
          ok: true,
          identical: plan.identical,
          hunks,
          unchangedAfterPx: plan.unchangedAfterPx,
          fullWidth: plan.fullWidth,
          fullHeight: plan.fullHeight,
          alignedFullHeight: plan.alignedFullHeight,
          hasFullPage: plan.hasFullPage,
          fullHighlights: plan.fullHighlights,
          fullDraftBlob,
          fullLiveBlob,
        };
        self.postMessage(resp);
      } finally {
        draftDecoded.bitmap.close();
        liveDecoded?.bitmap.close();
      }
      return;
    }

    if (req.kind === 'render_full_diff') {
      const draftDecoded = await decodeBlobToRgba(req.draftBlob);
      const liveDecoded = await decodeBlobToRgba(req.liveBlob);
      try {
        const width = draftDecoded.rgba.width;
        const alignedHeight = Math.max(draftDecoded.rgba.height, liveDecoded.rgba.height);
        const diffRgba = renderPerceptualDiffRgba(draftDecoded.rgba, liveDecoded.rgba, {
          cropX: 0,
          cropWidth: width,
          draftCropY: 0,
          draftCropHeight: draftDecoded.rgba.height,
          liveCropY: 0,
          liveCropHeight: liveDecoded.rgba.height,
          alignedHeight,
        });
        const diffBlob = await rgbaToBlob(diffRgba, width, alignedHeight);
        const resp: PerceptualWorkerResponse = {
          id: req.id,
          kind: 'render_full_diff',
          ok: true,
          diffBlob,
          width,
          height: alignedHeight,
        };
        self.postMessage(resp);
      } finally {
        draftDecoded.bitmap.close();
        liveDecoded.bitmap.close();
      }
    }
  } catch (err) {
    const resp: PerceptualWorkerResponse = {
      id: req.id,
      kind: 'error',
      ok: false,
      error: err instanceof Error ? err.message : 'Perceptual diff failed',
    };
    self.postMessage(resp);
  }
};
