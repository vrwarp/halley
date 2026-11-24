import { X } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
  headerRight?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

export function MobileFullSheet({
  title,
  subtitle,
  onClose,
  headerRight,
  footer,
  children,
}: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex flex-col bg-white"
    >
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-200 bg-white px-4 py-3"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-stone-900">{title}</h2>
          {subtitle && <p className="truncate text-[11px] text-stone-500">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {headerRight}
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>

      {footer && (
        <div
          className="shrink-0 border-t border-stone-200 bg-white px-4 py-3"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
