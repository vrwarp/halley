import { describe, expect, it, vi } from 'vitest';
import { createResyncScheduler, WsSequencer } from './ws-sequencer.js';

describe('WsSequencer', () => {
  it('applies every frame when the runner sends no seq/epoch (older runner)', () => {
    const s = new WsSequencer();
    expect(s.onOpen()).toBeNull();
    for (let i = 0; i < 5; i++) expect(s.observe({}).action).toBe('apply');
  });

  it('applies in-order frames and drops duplicates within the same epoch', () => {
    const s = new WsSequencer();
    s.onOpen();
    expect(s.observe({ seq: 1, epoch: 'a' }).action).toBe('apply');
    expect(s.observe({ seq: 2, epoch: 'a' }).action).toBe('apply');
    expect(s.observe({ seq: 2, epoch: 'a' })).toEqual({ action: 'drop', reason: 'duplicate', seq: 2, lastSeq: 2 });
    expect(s.observe({ seq: 1, epoch: 'a' }).action).toBe('drop');
    expect(s.observe({ seq: 3, epoch: 'a' }).action).toBe('apply');
    expect(s.snapshot()).toEqual({ lastSeq: 3, epoch: 'a' });
  });

  it('requests a resync on a gap and rebases on the new seq', () => {
    const s = new WsSequencer();
    s.onOpen();
    s.observe({ seq: 1, epoch: 'a' });
    const d = s.observe({ seq: 4, epoch: 'a' });
    expect(d).toMatchObject({ action: 'apply-and-resync', reason: 'gap' });
    expect(s.observe({ seq: 5, epoch: 'a' }).action).toBe('apply');
  });

  it('requests a resync when the epoch changes, even if seq went backwards', () => {
    const s = new WsSequencer();
    s.onOpen();
    s.observe({ seq: 10, epoch: 'a' });
    expect(s.observe({ seq: 1, epoch: 'b' })).toMatchObject({ action: 'apply-and-resync', reason: 'epoch-change' });
    expect(s.observe({ seq: 2, epoch: 'b' }).action).toBe('apply');
    expect(s.observe({ seq: 2, epoch: 'b' }).action).toBe('drop');
  });

  it('detects an epoch change from epoch alone (no seq)', () => {
    const s = new WsSequencer();
    s.onOpen();
    expect(s.observe({ epoch: 'a' }).action).toBe('apply');
    expect(s.observe({ epoch: 'b' }).action).toBe('apply-and-resync');
  });

  it('ignores malformed seq/epoch values instead of wedging', () => {
    const s = new WsSequencer();
    s.onOpen();
    expect(s.observe({ seq: '3', epoch: 42 }).action).toBe('apply');
    expect(s.observe({ seq: Number.NaN }).action).toBe('apply');
    expect(s.snapshot()).toEqual({ lastSeq: null, epoch: null });
  });

  it('resyncs on every reconnect but not on the first connect', () => {
    const s = new WsSequencer();
    expect(s.onOpen()).toBeNull();
    s.onClose(1006);
    expect(s.onOpen()).toBe('reconnect');
  });

  it('resyncs after 1012/1013 close codes, even before the first successful open', () => {
    for (const code of [1012, 1013]) {
      const s = new WsSequencer();
      s.onClose(code);
      expect(s.onOpen()).toBe('server-restart-close');
    }
  });

  it('does not double-resync for a gap on the first frame after a resyncing open', () => {
    const s = new WsSequencer();
    s.onOpen();
    s.observe({ seq: 1, epoch: 'a' });
    s.onClose(1006);
    expect(s.onOpen()).toBe('reconnect');
    // frames 2..9 were sent while we were offline: covered by the reconnect resync
    expect(s.observe({ seq: 10, epoch: 'a' }).action).toBe('apply');
    expect(s.observe({ seq: 12, epoch: 'a' }).action).toBe('apply-and-resync');
  });

  it('rebases (never drops) the first frame of a new connection whose counter restarted', () => {
    const s = new WsSequencer();
    s.onOpen();
    for (let i = 1; i <= 50; i++) s.observe({ seq: i, epoch: 'a' });
    s.onClose(1006);
    s.onOpen();
    expect(s.observe({ seq: 1, epoch: 'a' }).action).toBe('apply');
    expect(s.observe({ seq: 2, epoch: 'a' }).action).toBe('apply');
    expect(s.observe({ seq: 2, epoch: 'a' }).action).toBe('drop');
  });
});

describe('createResyncScheduler', () => {
  it('runs at most one resync at a time and coalesces requests made during it into one rerun', async () => {
    const resolvers: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((r) => resolvers.push(r)));
    const request = createResyncScheduler(run);
    request('gap');
    request('epoch-change');
    request('reconnect');
    expect(run).toHaveBeenCalledTimes(1);
    resolvers.shift()!();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith('reconnect');
    resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps working after a failed resync', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const request = createResyncScheduler(run);
    request('gap');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    request('gap');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });
});
