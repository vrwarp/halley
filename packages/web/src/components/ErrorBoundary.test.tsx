// No DOM environment is installed (jsdom / happy-dom are not in the offline pnpm store), so these
// tests render to static markup and drive handlers by walking the returned React element tree.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, LoadErrorScreen } from './ErrorBoundary.js';

type AnyProps = { children?: ReactNode; onClick?: () => void; [k: string]: unknown };

function findButtons(node: ReactNode, out: Array<ReactElement<AnyProps>> = []) {
  if (Array.isArray(node)) {
    for (const n of node) findButtons(n, out);
  } else if (isValidElement<AnyProps>(node)) {
    if (node.type === 'button') out.push(node);
    findButtons(node.props.children, out);
  }
  return out;
}
const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : isValidElement<AnyProps>(node)
      ? textOf(node.props.children)
      : node == null || typeof node === 'boolean'
        ? ''
        : String(node);

describe('LoadErrorScreen', () => {
  it('shows the message and the auto-retry countdown', () => {
    const html = renderToStaticMarkup(
      <LoadErrorScreen title="Couldn't load" message="HTTP 502" retryInMs={4000} onRetry={() => {}} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('HTTP 502');
    expect(html).toContain('Retrying automatically in 4s');
  });

  it('omits the countdown when auto-retry is off and never shows 0s', () => {
    expect(
      renderToStaticMarkup(<LoadErrorScreen title="t" message="m" retryInMs={null} onRetry={() => {}} />),
    ).not.toContain('Retrying automatically');
    expect(
      renderToStaticMarkup(<LoadErrorScreen title="t" message="m" retryInMs={10} onRetry={() => {}} />),
    ).toContain('in 1s');
  });

  it('Retry button invokes onRetry', () => {
    const onRetry = vi.fn();
    const tree = LoadErrorScreen({ title: 't', message: 'm', retryInMs: null, onRetry });
    const retry = findButtons(tree).find((b) => textOf(b) === 'Retry');
    retry!.props.onClick!();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorBoundary', () => {
  it('renders children while there is no error', () => {
    expect(renderToStaticMarkup(<ErrorBoundary>hello</ErrorBoundary>)).toBe('hello');
  });

  it('turns a thrown value into a recoverable screen, and "Try again" clears it', () => {
    const state = ErrorBoundary.getDerivedStateFromError('boom');
    expect(state.error).toBeInstanceOf(Error);
    const boundary = new ErrorBoundary({ children: 'child' });
    boundary.state = state;
    const setState = vi.fn();
    boundary.setState = setState as typeof boundary.setState;

    const fallback = boundary.render();
    const html = renderToStaticMarkup(<>{fallback}</>);
    expect(html).toContain('Something went wrong');
    expect(html).toContain('boom');

    const buttons = findButtons(fallback);
    expect(buttons.map(textOf)).toEqual(['Reload', 'Try again']);
    buttons[1]!.props.onClick!();
    expect(setState).toHaveBeenCalledWith({ error: null });
  });

  it('logs caught render errors', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    new ErrorBoundary({ children: null }).componentDidCatch(new Error('x'), { componentStack: '\n at Foo' });
    expect(err).toHaveBeenCalledWith('[halley] Unhandled render error', expect.any(Error), '\n at Foo');
    err.mockRestore();
  });
});
