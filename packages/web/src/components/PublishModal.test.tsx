// @vitest-environment happy-dom
import type { EditorSessionDto } from '@halley/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signals: AbortSignal[] = [];
const getReview = vi.fn();
const getReviewScreenshot = vi.fn();
const syncSession = vi.fn();
vi.mock('../api.js', () => ({
  api: {
    getReview: (...a: unknown[]) => getReview(...a),
    getReviewScreenshot: (...a: unknown[]) => getReviewScreenshot(...a),
    syncSession: (...a: unknown[]) => syncSession(...a),
  },
}));

const { PublishModal } = await import('./PublishModal.js');

const session = {
  id: 's1',
  title: 'Homepage tweaks',
  canEdit: true,
  kind: 'edit',
  status: 'ready',
  publishState: 'idle',
  publishError: null,
  prUrl: null,
  revertReason: null,
  workingBranch: 'halley/s1',
} as unknown as EditorSessionDto;

beforeEach(() => {
  signals.length = 0;
  syncSession.mockResolvedValue({ review: null });
  getReview.mockResolvedValue({ cards: [], targetRoutes: ['/', '/about'], mergeReview: null });
  // Screenshot requests hang until aborted, like a slow server render.
  getReviewScreenshot.mockImplementation(
    (_id: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signals.push(opts.signal);
        opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderModal(onClose = vi.fn()) {
  return render(
    <PublishModal
      session={session}
      currentRoute="/"
      publishProgress={null}
      onClose={onClose}
      onAskHalleyToFix={async () => {}}
      onStartNewEdit={() => {}}
      onChangedFilesUpdated={async () => {}}
    />,
  );
}

describe('PublishModal', () => {
  it('aborts in-flight screenshot requests when closed (unmounted), without reporting them', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const view = renderModal();
    await act(async () => {});
    expect(getReview).toHaveBeenCalledTimes(1);
    expect(getReviewScreenshot).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => !s.aborted)).toBe(true);

    view.unmount();
    expect(signals.every((s) => s.aborted)).toBe(true);
    await act(async () => {});
    // Aborts are expected on close: not reported as screenshot failures.
    expect(debug.mock.calls.some((c) => String(c[0]).includes('screenshot diff failed'))).toBe(false);
  });

  it('the close button calls onClose', async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    await act(async () => {});
    const closeButtons = screen
      .getAllByRole('button')
      .filter((b) => /close|cancel|not now/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
    expect(closeButtons.length).toBeGreaterThan(0);
    fireEvent.click(closeButtons[0]!);
    expect(onClose).toHaveBeenCalled();
  });
});
