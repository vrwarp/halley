import type { VisualDiffHunkDto, VisualDiffPageDto, VisualDiffViewportShotDto } from '@halley/shared';
import {
  computePerceptualDiffPlan,
  renderPerceptualDiffRgba,
  type RgbaImage,
} from './perceptual-diff-core.js';
import type {
  PerceptualWorkerRequest,
  PerceptualWorkerResponse,
  WorkerHunkOutput,
} from './perceptual-diff.worker.js';

let workerInstance: Worker | null = null;
let workerFailed = false;
let nextRequestId = 1;
const pendingRequests = new Map<
  number,
  {
    resolve: (res: PerceptualWorkerResponse) => void;
    reject: (err: Error) => void;
  }
>();

function canUseWorker(): boolean {
  return (
    !workerFailed &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  );
}

function getWorker(): Worker | null {
  if (!canUseWorker()) return null;
  if (workerInstance) return workerInstance;
  try {
    const w = new Worker(new URL('./perceptual-diff.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (event: MessageEvent<PerceptualWorkerResponse>) => {
      const msg = event.data;
      const entry = pendingRequests.get(msg.id);
      if (!entry) return;
      pendingRequests.delete(msg.id);
      if (!msg.ok) {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg);
      }
    };
    w.onerror = () => {
      workerFailed = true;
      workerInstance = null;
      for (const [, entry] of pendingRequests) {
        entry.reject(new Error('Perceptual diff worker failed'));
      }
      pendingRequests.clear();
    };
    workerInstance = w;
    return w;
  } catch {
    workerFailed = true;
    return null;
  }
}

function sendToWorker(req: PerceptualWorkerRequest): Promise<PerceptualWorkerResponse> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('Worker unavailable'));
  return new Promise((resolve, reject) => {
    pendingRequests.set(req.id, { resolve, reject });
    w.postMessage(req);
  });
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return res.blob();
}

async function loadHtmlImage(blob: Blob): Promise<HTMLImageElement> {
  const objUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode screenshot image'));
      img.src = objUrl;
    });
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

function decodeImageMainThread(img: HTMLImageElement): RgbaImage {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('canvas.toBlob returned null'));
      },
      'image/webp',
      0.88,
    );
  });
}

async function sliceAndPadMainThread(
  img: HTMLImageElement,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  alignedHeight: number,
): Promise<Blob> {
  const safeW = Math.max(1, cropWidth);
  const safeH = Math.max(1, cropHeight);
  const outH = Math.max(safeH, alignedHeight);
  const canvas = document.createElement('canvas');
  canvas.width = safeW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  if (outH > safeH) {
    ctx.fillStyle = '#F5F5F4';
    ctx.fillRect(0, 0, safeW, outH);
  }
  ctx.drawImage(img, cropX, cropY, safeW, safeH, 0, 0, safeW, safeH);
  if (outH > safeH) {
    ctx.fillStyle = '#D6D3D1';
    ctx.fillRect(0, safeH, safeW, 1);
  }
  return canvasToBlob(canvas);
}

async function rgbaToBlobMainThread(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const clamped = new Uint8ClampedArray(rgba.length);
  clamped.set(rgba);
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  return canvasToBlob(canvas);
}

async function processRouteMainThread(
  draftBlob: Blob,
  liveBlob: Blob | undefined,
  highlights: VisualDiffPageDto['highlights'],
): Promise<Extract<PerceptualWorkerResponse, { kind: 'process_route' }>> {
  const draftImg = await loadHtmlImage(draftBlob);
  const draftRgba = decodeImageMainThread(draftImg);
  const liveImg = liveBlob ? await loadHtmlImage(liveBlob) : null;
  const liveRgba = liveImg ? decodeImageMainThread(liveImg) : null;

  const plan = computePerceptualDiffPlan(draftRgba, liveRgba, highlights);
  const hunks: WorkerHunkOutput[] = [];

  for (const h of plan.hunks) {
    const draftSlice = await sliceAndPadMainThread(
      draftImg,
      h.cropX,
      h.draftCropY,
      h.cropWidth,
      h.draftCropHeight,
      h.alignedHeight,
    );
    let liveSlice: Blob | undefined;
    let diffSlice: Blob | undefined;
    if (liveImg && liveRgba && h.liveCropY !== undefined && h.liveCropHeight !== undefined) {
      liveSlice = await sliceAndPadMainThread(
        liveImg,
        h.cropX,
        h.liveCropY,
        h.cropWidth,
        h.liveCropHeight,
        h.alignedHeight,
      );
      const diffRgba = renderPerceptualDiffRgba(draftRgba, liveRgba, {
        cropX: h.cropX,
        cropWidth: h.cropWidth,
        draftCropY: h.draftCropY,
        draftCropHeight: h.draftCropHeight,
        liveCropY: h.liveCropY,
        liveCropHeight: h.liveCropHeight,
        alignedHeight: h.alignedHeight,
      });
      diffSlice = await rgbaToBlobMainThread(diffRgba, h.cropWidth, h.alignedHeight);
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

  let fullDraftBlob: Blob | undefined;
  let fullLiveBlob: Blob | undefined;
  if (liveImg && liveRgba && liveRgba.width === draftRgba.width && liveRgba.height !== draftRgba.height) {
    fullDraftBlob = await sliceAndPadMainThread(
      draftImg,
      0,
      0,
      draftRgba.width,
      draftRgba.height,
      plan.alignedFullHeight,
    );
    fullLiveBlob = await sliceAndPadMainThread(
      liveImg,
      0,
      0,
      liveRgba.width,
      liveRgba.height,
      plan.alignedFullHeight,
    );
  }

  return {
    id: 0,
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
}

export interface ProcessedVisualDiffResult {
  croppedPage: VisualDiffPageDto;
  fullPage: VisualDiffPageDto;
  objectUrls: string[];
  rawDraftUrl?: string;
  rawLiveUrl?: string;
}

export function revokeObjectUrls(urls: string[]): void {
  for (const u of urls) {
    if (u.startsWith('blob:')) {
      URL.revokeObjectURL(u);
    }
  }
}

/**
 * Processes a raw full-page VisualDiffPageDto returned by the server into both:
 * - `croppedPage`: perceptual multi-hunk cropped diff + rose-on-dimmed-Draft `diffScreenshotDataUrl`
 * - `fullPage`: instant full-page Live & Draft (height-aligned if needed)
 * Runs off the main thread in a Web Worker when available, with automatic `<canvas>` fallback.
 */
export async function processVisualDiffPageClient(
  rawPage: VisualDiffPageDto,
  viewport: 'mobile' | 'desktop',
): Promise<ProcessedVisualDiffResult> {
  const rawShot = rawPage.shots?.[viewport];
  const rawDraftUrl =
    rawShot?.draftScreenshotDataUrl ??
    (viewport === 'mobile' ? rawPage.mobileDraftScreenshotDataUrl : rawPage.draftScreenshotDataUrl);
  const rawLiveUrl =
    rawShot?.liveScreenshotDataUrl ??
    (viewport === 'mobile' ? rawPage.mobileLiveScreenshotDataUrl : rawPage.liveScreenshotDataUrl);
  const rawHighlights = rawShot?.highlights ?? rawPage.highlights ?? [];

  if (!rawDraftUrl) {
    return { croppedPage: rawPage, fullPage: rawPage, objectUrls: [] };
  }

  const objectUrls: string[] = [];
  const trackUrl = (blob: Blob): string => {
    const u = URL.createObjectURL(blob);
    objectUrls.push(u);
    return u;
  };

  try {
    const [draftBlob, liveBlob] = await Promise.all([
      dataUrlToBlob(rawDraftUrl),
      rawLiveUrl ? dataUrlToBlob(rawLiveUrl) : Promise.resolve(undefined),
    ]);

    let result: Extract<PerceptualWorkerResponse, { kind: 'process_route' }>;
    try {
      const id = nextRequestId++;
      const workerResp = await sendToWorker({
        id,
        kind: 'process_route',
        draftBlob,
        liveBlob,
        highlights: rawHighlights,
      });
      if (workerResp.kind !== 'process_route') {
        throw new Error('Unexpected worker response');
      }
      result = workerResp;
    } catch {
      result = await processRouteMainThread(draftBlob, liveBlob, rawHighlights);
    }

    const hunks: VisualDiffHunkDto[] = result.hunks.map((h) => ({
      id: h.id,
      draftScreenshotDataUrl: trackUrl(h.draftBlob),
      liveScreenshotDataUrl: h.liveBlob ? trackUrl(h.liveBlob) : undefined,
      diffScreenshotDataUrl: h.diffBlob ? trackUrl(h.diffBlob) : undefined,
      highlights: h.highlights,
      width: h.width,
      height: h.height,
      draftCropY: h.draftCropY,
      draftCropHeight: h.draftCropHeight,
      liveCropY: h.liveCropY,
      liveCropHeight: h.liveCropHeight,
      cropX: h.cropX,
      cropWidth: h.cropWidth,
      unchangedBeforePx: h.unchangedBeforePx,
    }));

    const firstHunk = hunks[0];
    const croppedShot: VisualDiffViewportShotDto = {
      draftScreenshotDataUrl: firstHunk?.draftScreenshotDataUrl,
      liveScreenshotDataUrl: firstHunk?.liveScreenshotDataUrl,
      diffScreenshotDataUrl: firstHunk?.diffScreenshotDataUrl,
      highlights: firstHunk?.highlights ?? [],
      width: firstHunk?.width ?? result.fullWidth,
      height: firstHunk?.height ?? 0,
      hunks,
      unchangedAfterPx: result.unchangedAfterPx,
      identical: result.identical,
      fullWidth: result.fullWidth,
      fullHeight: result.fullHeight,
      hasFullPage: result.hasFullPage,
    };

    const fullDraftUrl = result.fullDraftBlob ? trackUrl(result.fullDraftBlob) : rawDraftUrl;
    const fullLiveUrl = result.fullLiveBlob ? trackUrl(result.fullLiveBlob) : rawLiveUrl;

    const fullShot: VisualDiffViewportShotDto = {
      draftScreenshotDataUrl: fullDraftUrl,
      liveScreenshotDataUrl: fullLiveUrl,
      highlights: result.fullHighlights,
      width: result.fullWidth,
      height: result.alignedFullHeight,
      fullWidth: result.fullWidth,
      fullHeight: result.fullHeight,
      hasFullPage: true,
    };

    const makePageDto = (shot: VisualDiffViewportShotDto): VisualDiffPageDto => ({
      ...rawPage,
      liveScreenshotDataUrl: viewport === 'desktop' ? shot.liveScreenshotDataUrl : undefined,
      draftScreenshotDataUrl: viewport === 'desktop' ? shot.draftScreenshotDataUrl : undefined,
      mobileLiveScreenshotDataUrl: viewport === 'mobile' ? shot.liveScreenshotDataUrl : undefined,
      mobileDraftScreenshotDataUrl: viewport === 'mobile' ? shot.draftScreenshotDataUrl : undefined,
      highlights: shot.highlights,
      viewport,
      shots: {
        ...rawPage.shots,
        [viewport]: shot,
      },
    });

    return {
      croppedPage: makePageDto(croppedShot),
      fullPage: makePageDto(fullShot),
      objectUrls,
      rawDraftUrl,
      rawLiveUrl,
    };
  } catch {
    revokeObjectUrls(objectUrls);
    return { croppedPage: rawPage, fullPage: rawPage, objectUrls: [], rawDraftUrl, rawLiveUrl };
  }
}

/**
 * Lazily renders a full-page perceptual diff overlay (`blob:` URL) when the user
 * clicks "Diff" while viewing a page in "Full page" mode.
 */
export async function renderFullDiffClient(
  rawDraftUrl: string,
  rawLiveUrl: string,
): Promise<{ diffUrl: string; objectUrl: string } | null> {
  try {
    const [draftBlob, liveBlob] = await Promise.all([
      dataUrlToBlob(rawDraftUrl),
      dataUrlToBlob(rawLiveUrl),
    ]);

    let diffBlob: Blob;
    try {
      const id = nextRequestId++;
      const resp = await sendToWorker({ id, kind: 'render_full_diff', draftBlob, liveBlob });
      if (resp.kind !== 'render_full_diff') throw new Error('Unexpected worker response');
      diffBlob = resp.diffBlob;
    } catch {
      const [draftImg, liveImg] = await Promise.all([
        loadHtmlImage(draftBlob),
        loadHtmlImage(liveBlob),
      ]);
      const draftRgba = decodeImageMainThread(draftImg);
      const liveRgba = decodeImageMainThread(liveImg);
      const alignedHeight = Math.max(draftRgba.height, liveRgba.height);
      const diffRgba = renderPerceptualDiffRgba(draftRgba, liveRgba, {
        cropX: 0,
        cropWidth: draftRgba.width,
        draftCropY: 0,
        draftCropHeight: draftRgba.height,
        liveCropY: 0,
        liveCropHeight: liveRgba.height,
        alignedHeight,
      });
      diffBlob = await rgbaToBlobMainThread(diffRgba, draftRgba.width, alignedHeight);
    }

    const objectUrl = URL.createObjectURL(diffBlob);
    return { diffUrl: objectUrl, objectUrl };
  } catch (err) {
    console.warn('[halley] perceptual diff image failed', err);
    return null;
  }
}
