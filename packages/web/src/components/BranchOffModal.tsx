import { GitBranch, Loader2 } from 'lucide-react';
import { useEffect } from 'react';

interface Props {
  draftTitle: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BranchOffModal({ draftTitle, busy, error, onCancel, onConfirm }: Props) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/35 p-4 backdrop-blur-[2px]"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-off-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-5 shadow-xl space-y-4 sm:p-6"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-stone-100 text-stone-700">
            <GitBranch className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 id="branch-off-modal-title" className="text-base font-semibold text-stone-900">
              Branch off &ldquo;{draftTitle}&rdquo;?
            </h3>
            <p className="mt-1 text-xs text-stone-500">
              This creates a separate draft &mdash;{' '}
              <span className="font-medium text-stone-700">&ldquo;{draftTitle} (Copy)&rdquo;</span>{' '}
              &mdash; and opens that new instance right away.
            </p>
          </div>
        </div>

        <ul className="space-y-2 rounded-xl border border-stone-200/80 bg-[#FAF9F7] px-3.5 py-3 text-xs text-stone-600">
          <li className="flex gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400" />
            <span>
              <strong className="font-semibold text-stone-800">Copies your current progress:</strong>{' '}
              carries over all page changes, uploaded images, and context summary.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400" />
            <span>
              <strong className="font-semibold text-stone-800">Leaves this draft untouched:</strong>{' '}
              &ldquo;{draftTitle}&rdquo; stays right where it is so you can try a different direction
              or publish them separately.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400" />
            <span>
              <strong className="font-semibold text-stone-800">Isolated live preview:</strong>{' '}
              starts a fresh workspace without affecting your live site.
            </span>
          </li>
        </ul>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-[40px] rounded-lg px-3.5 py-2 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-stone-900 px-4 py-2 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Branching off…
              </>
            ) : (
              <>
                <GitBranch className="h-3.5 w-3.5" />
                Branch off
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
