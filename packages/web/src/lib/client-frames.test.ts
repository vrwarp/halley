import type { TranscriptEntryDto } from '@halley/shared';
import { describe, expect, it, vi } from 'vitest';
import { parseServerFrame, shareTranscriptEntries } from './client-frames.js';
import { backoffDelayMs } from './retry.js';

const entry = (id: string, text: string): TranscriptEntryDto =>
  ({ id, role: 'assistant', text, createdAt: 0 }) as unknown as TranscriptEntryDto;

describe('parseServerFrame', () => {
  it('rejects malformed frames without throwing (and logs the malformed one)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseServerFrame('this is not json')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(parseServerFrame('null')).toBeNull();
    expect(parseServerFrame('[1,2]')).toBeNull();
    expect(parseServerFrame('{"type":5}')).toBeNull();
    expect(parseServerFrame('"str"')).toBeNull();
    expect(parseServerFrame(new ArrayBuffer(2))).toBeNull();
  });
  it('accepts objects with a string type', () => {
    expect(parseServerFrame('{"type":"error","message":"x"}')).toEqual({ type: 'error', message: 'x' });
  });
});

describe('shareTranscriptEntries', () => {
  it('returns the previous array when nothing changed', () => {
    const prev = [entry('a', 'hi'), entry('b', 'yo')];
    const next = JSON.parse(JSON.stringify(prev)) as TranscriptEntryDto[];
    expect(shareTranscriptEntries(prev, next)).toBe(prev);
  });
  it('reuses unchanged entries and swaps changed/appended ones', () => {
    const prev = [entry('a', 'hi'), entry('b', 'yo')];
    const next = [entry('a', 'hi'), entry('b', 'yo!'), entry('c', 'new')];
    const out = shareTranscriptEntries(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
    expect(out[2]).toBe(next[2]);
  });
});

describe('backoffDelayMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map((n) => backoffDelayMs(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});
