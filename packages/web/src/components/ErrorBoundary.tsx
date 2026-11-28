import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level boundary: a render-time exception anywhere in the tree shows a recoverable
 * screen instead of unmounting the whole app to a blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[halley] Unhandled render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#FAF9F7] px-6 text-center text-sm text-stone-600"
      >
        <p className="text-base font-semibold text-stone-900">Something went wrong</p>
        <p className="max-w-md break-words text-xs text-stone-500">{error.message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-800"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

/** Full-screen "couldn't load" state with a Retry button and the next auto-retry countdown. */
export function LoadErrorScreen({
  title,
  message,
  retryInMs,
  onRetry,
  extra,
}: {
  title: string;
  message: string;
  retryInMs: number | null;
  onRetry: () => void;
  extra?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#FAF9F7] px-6 text-center text-sm text-stone-600"
    >
      <p className="text-base font-semibold text-stone-900">{title}</p>
      <p className="max-w-md break-words text-xs text-red-700" data-testid="load-error-message">
        {message}
      </p>
      {retryInMs !== null && (
        <p className="text-[11px] text-stone-400">
          Retrying automatically in {Math.max(1, Math.round(retryInMs / 1000))}s…
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-800"
        >
          Retry
        </button>
        {extra}
      </div>
    </div>
  );
}
