// @vitest-environment happy-dom
import type { ChatServerMessage } from '@halley/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({ api: { sendClientMessage: vi.fn() } }));

import { api } from '../api.js';
import { reconnectDelayMs, useChatSocket } from './useChatSocket.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: unknown }) => void) | null = null;
  onclose: ((evt: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  // Test drivers
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  frame(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const spendFrame = (seq: number, epoch = 'boot-1') => ({
  type: 'spend_status',
  seq,
  epoch,
  spentTodayUsd: 0,
  dailyCapUsd: 10,
  extraGrantedUsd: 0,
  capped: false,
});

function setup() {
  const onMessage = vi.fn<(msg: ChatServerMessage) => void>();
  const onResync = vi.fn<(reason: string) => Promise<void>>(() => Promise.resolve());
  const onSendError = vi.fn<(text: string) => void>();
  const haltedRef = { current: false };
  const hook = renderHook(() =>
    useChatSocket({ sessionId: 's1', haltedRef, onMessage, onResync, onSendError }),
  );
  const ws = () => FakeWebSocket.instances.at(-1)!;
  return { hook, ws, onMessage, onResync, onSendError, haltedRef };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useChatSocket', () => {
  it('connects to the session socket and reports open', () => {
    const { hook, ws } = setup();
    expect(ws().url).toMatch(/\/ws\/sessions\/s1$/);
    expect(hook.result.current.wsStatus).toBe('connecting');
    act(() => ws().open());
    expect(hook.result.current.wsConnected).toBe(true);
    expect(hook.result.current.wsStatus).toBe('open');
  });

  it('applies frames in order without resyncing, and resyncs once on a seq gap', async () => {
    const { ws, onMessage, onResync } = setup();
    act(() => ws().open());
    act(() => {
      ws().frame(spendFrame(1));
      ws().frame(spendFrame(2));
    });
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onResync).not.toHaveBeenCalled();

    // seq 3 and 4 lost: frame 5 is still applied, and a full resync is requested.
    await act(async () => ws().frame(spendFrame(5)));
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage.mock.calls[2]![0]).toMatchObject({ seq: 5 });
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenCalledWith('gap');

    // Back in order after the rebase: no further resync; duplicates are dropped.
    await act(async () => {
      ws().frame(spendFrame(6));
      ws().frame(spendFrame(6));
    });
    expect(onMessage).toHaveBeenCalledTimes(4);
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('coalesces resync requests while one is in flight', async () => {
    const { ws, onResync } = setup();
    let finish!: () => void;
    onResync.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    act(() => ws().open());
    await act(async () => {
      ws().frame(spendFrame(1));
      ws().frame(spendFrame(3)); // gap -> resync #1 (in flight)
      ws().frame(spendFrame(5)); // gap -> queued
      ws().frame(spendFrame(7)); // gap -> still one queued
    });
    expect(onResync).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('resyncs on an epoch change (runner restart)', async () => {
    const { ws, onResync } = setup();
    act(() => ws().open());
    await act(async () => {
      ws().frame(spendFrame(10, 'boot-1'));
      ws().frame(spendFrame(1, 'boot-2'));
    });
    expect(onResync).toHaveBeenCalledWith('epoch-change');
  });

  it('reconnects with backoff after a drop and resyncs on the new connection', async () => {
    vi.useFakeTimers();
    const { hook, ws, onResync } = setup();
    act(() => ws().open());
    act(() => ws().drop(1006));
    expect(hook.result.current.wsStatus).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(2600));
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => ws().open());
    expect(hook.result.current.wsStatus).toBe('open');
    expect(onResync).toHaveBeenCalledWith('reconnect');
  });

  it('goes offline instead of reconnecting while halted (crash loop)', () => {
    vi.useFakeTimers();
    const { hook, ws, haltedRef } = setup();
    act(() => ws().open());
    haltedRef.current = true;
    act(() => ws().drop(1006));
    expect(hook.result.current.wsStatus).toBe('offline');
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('sends over the open socket, else falls back to HTTP and reports failures', async () => {
    const { hook, ws, onSendError } = setup();
    // Not open yet: HTTP fallback
    vi.mocked(api.sendClientMessage).mockResolvedValueOnce(undefined as never);
    await expect(hook.result.current.dispatchClientMessage({ type: 'ping' })).resolves.toBe(true);
    expect(api.sendClientMessage).toHaveBeenCalledWith('s1', { type: 'ping' });

    act(() => ws().open());
    await expect(hook.result.current.dispatchClientMessage({ type: 'submit_input' })).resolves.toBe(true);
    expect(ws().sent).toEqual([JSON.stringify({ type: 'submit_input' })]);

    act(() => ws().drop(1006));
    vi.mocked(api.sendClientMessage).mockRejectedValueOnce(new Error('offline'));
    await expect(hook.result.current.dispatchClientMessage({ type: 'x' })).resolves.toBe(false);
    expect(onSendError).toHaveBeenCalledWith("Couldn't send to Halley: offline");
  });
});

describe('reconnectDelayMs', () => {
  it('doubles from 2s and caps at 30s plus jitter', () => {
    const noJitter = () => 0;
    expect([1, 2, 3, 4, 5, 6, 10].map((n) => reconnectDelayMs(n, noJitter))).toEqual([
      2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(reconnectDelayMs(1, () => 0.999)).toBe(2499);
  });
});
