// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorFrameText, parseServerFrame } from '../lib/client-frames.js';
import { ErrorNoticeBanner, WsConnectionIndicator } from './EditorStatusOverlays.js';

afterEach(cleanup);

describe('WsConnectionIndicator', () => {
  it('renders nothing while connecting or connected', () => {
    const { container, rerender } = render(<WsConnectionIndicator status="connecting" onRetry={() => {}} />);
    expect(container.innerHTML).toBe('');
    rerender(<WsConnectionIndicator status="open" onRetry={() => {}} />);
    expect(screen.queryByTestId('ws-connection-indicator')).toBeNull();
  });

  it('shows reconnecting with a working "Retry now"', () => {
    const onRetry = vi.fn();
    render(<WsConnectionIndicator status="reconnecting" onRetry={onRetry} />);
    const el = screen.getByTestId('ws-connection-indicator');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.textContent).toContain('Live updates disconnected — reconnecting…');
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows offline without a retry button', () => {
    render(<WsConnectionIndicator status="offline" onRetry={() => {}} />);
    expect(screen.getByTestId('ws-connection-indicator').textContent).toContain('Live updates offline');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('error frame notice', () => {
  it('a server error frame becomes a dismissible alert with its message', () => {
    const frame = parseServerFrame(JSON.stringify({ type: 'error', message: 'Runner crashed' }))!;
    expect(frame.type).toBe('error');
    const onDismiss = vi.fn();
    render(<ErrorNoticeBanner text={errorFrameText(frame as { message?: unknown })} onDismiss={onDismiss} />);
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-testid')).toBe('editor-error-notice');
    expect(alert.textContent).toContain('Runner crashed');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic message for error frames without one', () => {
    expect(errorFrameText({})).toBe('Server error');
    expect(errorFrameText({ message: '' })).toBe('Server error');
    expect(errorFrameText({ message: 42 })).toBe('Server error');
  });
});
