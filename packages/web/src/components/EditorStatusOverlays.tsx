import { AlertTriangle, Loader2, X } from 'lucide-react';

/** 'connecting' until the first open; 'reconnecting' after a drop; 'offline' when halted (crash loop). */
export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'offline';

/** Top-of-editor error banner (server `error` frames, failed sends, meta load errors). */
export function ErrorNoticeBanner({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      data-testid="editor-error-notice"
      className="fixed left-1/2 top-3 z-[200] flex w-max max-w-[calc(100%-32px)] -translate-x-1/2 items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
      <span className="min-w-0 break-words">{text}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 text-red-700 hover:text-red-950"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Bottom-left live-updates indicator; renders nothing while connecting or connected. */
export function WsConnectionIndicator({ status, onRetry }: { status: WsStatus; onRetry: () => void }) {
  if (status !== 'reconnecting' && status !== 'offline') return null;
  return (
    <div
      role="status"
      data-testid="ws-connection-indicator"
      className="fixed bottom-3 left-3 z-[150] flex items-center gap-1.5 rounded-full border border-stone-300 bg-white/95 px-2.5 py-1 text-[11px] text-stone-600 shadow"
    >
      {status === 'reconnecting' ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin text-amber-600" />
          <span>Live updates disconnected — reconnecting…</span>
          <button
            type="button"
            onClick={onRetry}
            className="font-semibold text-stone-800 underline underline-offset-2"
          >
            Retry now
          </button>
        </>
      ) : (
        <>
          <span className="h-2 w-2 rounded-full bg-stone-400" />
          <span>Live updates offline</span>
        </>
      )}
    </div>
  );
}
