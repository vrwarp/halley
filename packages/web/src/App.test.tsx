// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const me = vi.fn();
const listSessions = vi.fn();
vi.mock('./api.js', () => ({
  api: {
    me: (...a: unknown[]) => me(...a),
    listSessions: (...a: unknown[]) => listSessions(...a),
    logout: vi.fn(),
    devLogin: vi.fn(),
  },
}));

const { App } = await import('./App.js');

/** Let pending promise callbacks (and the React updates they trigger) run. */
const flush = () => act(async () => {});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  me.mockReset();
  listSessions.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('App initial load', () => {
  it('shows the error + Retry, retries with exponential backoff, then recovers', async () => {
    me.mockRejectedValueOnce(new Error('Network down'))
      .mockRejectedValueOnce(new Error('Still down'))
      .mockResolvedValue({ authenticated: false, repo: 'acme/site' });

    render(<App />);
    await flush();
    expect(me).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Couldn't load Halley")).toBeTruthy();
    expect(screen.getByTestId('load-error-message').textContent).toBe('Network down');
    expect(screen.getByText(/Retrying automatically in 1s/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    // First backoff is 1s: nothing happens before it elapses.
    await advance(999);
    expect(me).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(me).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('load-error-message').textContent).toBe('Still down');
    expect(screen.getByText(/Retrying automatically in 2s/)).toBeTruthy();

    // Second backoff doubles to 2s.
    await advance(1999);
    expect(me).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(me).toHaveBeenCalledTimes(3);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Sign in with your team Google account/)).toBeTruthy();
    // No further retries once recovered.
    await advance(60_000);
    expect(me).toHaveBeenCalledTimes(3);
  });

  it('manual Retry retries immediately and resets the backoff', async () => {
    me.mockRejectedValueOnce(new Error('down 1'))
      .mockRejectedValueOnce(new Error('down 2'))
      .mockRejectedValueOnce(new Error('down 3'))
      .mockResolvedValue({ authenticated: false, repo: 'acme/site' });

    render(<App />);
    await flush();
    await advance(1000); // auto retry #1 -> next delay 2s
    expect(me).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Retrying automatically in 2s/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(me).toHaveBeenCalledTimes(3);
    // Backoff reset by the manual retry: back to 1s, and the old 2s timer was cancelled.
    expect(screen.getByText(/Retrying automatically in 1s/)).toBeTruthy();
    await advance(1000);
    expect(me).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
