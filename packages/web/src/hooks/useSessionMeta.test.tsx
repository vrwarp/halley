// @vitest-environment happy-dom
import type { EditorSessionDto } from '@halley/shared';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  api: {
    getSession: vi.fn(),
    getChanges: vi.fn(),
    getRoutes: vi.fn(),
    wakeSession: vi.fn(),
  },
}));

import { api } from '../api.js';
import { useSessionMeta } from './useSessionMeta.js';

type GetSessionResult = Awaited<ReturnType<typeof api.getSession>>;

const spend = { spentTodayUsd: 0, dailyCapUsd: 10, extraGrantedUsd: 0, capped: false };

function sessionResult(title: string, overrides: Partial<EditorSessionDto> = {}): GetSessionResult {
  return {
    session: {
      id: 's1',
      title,
      status: 'published',
      canEdit: true,
      astroReady: true,
      changedFilesCount: title.length,
      ...overrides,
    } as EditorSessionDto,
    spend,
  } as GetSessionResult;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const onReadOnly = vi.fn();
  const hook = renderHook(() => useSessionMeta({ sessionId: 's1', initialSpend: spend, onReadOnly }));
  return { hook, onReadOnly };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('useSessionMeta', () => {
  it('loads the session on mount', async () => {
    vi.mocked(api.getSession).mockResolvedValueOnce(sessionResult('First'));
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.session?.title).toBe('First'));
    expect(hook.result.current.changedCount).toBe('First'.length);
    expect(hook.result.current.initialLoadError).toBeNull();
  });

  it('ignores a stale response that resolves after a newer request', async () => {
    const initial = deferred<GetSessionResult>();
    const refresh = deferred<GetSessionResult>();
    vi.mocked(api.getSession).mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise);
    const { hook } = setup();
    expect(api.getSession).toHaveBeenCalledTimes(1);

    let refreshResult: Promise<unknown> | undefined;
    act(() => {
      refreshResult = hook.result.current.loadSessionMeta();
    });
    expect(api.getSession).toHaveBeenCalledTimes(2);

    // Newer request answers first...
    await act(async () => {
      refresh.resolve(sessionResult('Fresh'));
      await refreshResult;
    });
    expect(hook.result.current.session?.title).toBe('Fresh');

    // ...then the superseded one: it must not overwrite the fresh state.
    await act(async () => {
      initial.resolve(sessionResult('Stale!', { canEdit: false }));
      await initial.promise;
    });
    expect(hook.result.current.session?.title).toBe('Fresh');
    expect(hook.result.current.changedCount).toBe('Fresh'.length);
  });

  it('a superseded request that fails does not surface a load error', async () => {
    const initial = deferred<GetSessionResult>();
    vi.mocked(api.getSession).mockReturnValueOnce(initial.promise).mockResolvedValueOnce(sessionResult('Fresh'));
    const { hook, onReadOnly } = setup();
    await act(async () => {
      await hook.result.current.loadSessionMeta();
    });
    await act(async () => {
      initial.reject(new Error('network down'));
      await initial.promise.catch((err: unknown) => err);
    });
    expect(hook.result.current.session?.title).toBe('Fresh');
    expect(hook.result.current.initialLoadError).toBeNull();
    expect(hook.result.current.metaError).toBeNull();
    expect(onReadOnly).not.toHaveBeenCalled();
  });

  it('shows an initial-load error with a retry delay and recovers via retryInitialLoad', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.getSession)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(sessionResult('Recovered', { canEdit: false }));
      const { hook, onReadOnly } = setup();
      await act(async () => {
        await Promise.resolve();
      });
      expect(hook.result.current.initialLoadError).toEqual({ message: 'boom', retryInMs: 1000 });
      // Manual retry before the 1s auto-retry fires: the pending timer is cancelled, one new request.
      await act(async () => {
        hook.result.current.retryInitialLoad();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(api.getSession).toHaveBeenCalledTimes(2);
      expect(hook.result.current.session?.title).toBe('Recovered');
      expect(hook.result.current.initialLoadError).toBeNull();
      expect(onReadOnly).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
