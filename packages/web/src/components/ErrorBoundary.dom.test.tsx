// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary.js';

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error('Render exploded');
  return <p>Recovered content</p>;
}

beforeEach(() => {
  shouldThrow = true;
  // React logs caught render errors; the boundary logs too. Keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary (DOM)', () => {
  it('shows the fallback with the error message instead of a blank page', () => {
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).toContain('Render exploded');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(console.error).toHaveBeenCalledWith(
      '[halley] Unhandled render error',
      expect.any(Error),
      expect.anything(),
    );
  });

  it('"Try again" re-renders the children once the cause is gone', () => {
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Recovered content')).toBeTruthy();
  });

  it('"Reload" reloads the page', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      render(
        <ErrorBoundary>
          <Flaky />
        </ErrorBoundary>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
