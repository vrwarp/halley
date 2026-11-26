import type { PageRequestMetadata } from '@halley/shared';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  EyeOff,
  FilePlus,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';

interface Props {
  pageRequest: PageRequestMetadata;
  liveUnlisted?: boolean;
  persona: 'non-technical' | 'developer';
  canEdit: boolean;
  spendCapped: boolean;
  onNavigateRoute: (route: string) => void;
  onRetry: (pageRequestId: string) => Promise<void>;
  onDelete: (route: string) => Promise<void>;
}

export function pageStatusText(status: PageRequestMetadata['status']): string {
  switch (status) {
    case 'created':
      return 'Starter page created…';
    case 'queued':
      return 'Queued — Halley will write this after the current task';
    case 'writing':
      return 'Writing page content…';
    case 'photo':
      return 'Optimizing & adding hero photo…';
    case 'menu':
      return 'Updating navigation menu…';
    case 'done':
      return 'Page ready';
    case 'capped':
      return 'Daily AI budget reached — page created, content will need to be added later or ask an admin';
    case 'failed':
      return 'Halley could not finish writing this page';
  }
}

export function NewPageCard({
  pageRequest,
  liveUnlisted,
  persona,
  canEdit,
  spendCapped,
  onNavigateRoute,
  onRetry,
  onDelete,
}: Props) {
  const [showInstructions, setShowInstructions] = useState(false);
  const [busyAction, setBusyAction] = useState<'retry' | 'delete' | null>(null);

  const isUnlisted = liveUnlisted !== undefined ? liveUnlisted : pageRequest.unlisted;
  const isWorking =
    pageRequest.status === 'created' ||
    pageRequest.status === 'writing' ||
    pageRequest.status === 'photo' ||
    pageRequest.status === 'menu';

  return (
    <div className="rounded-xl border border-stone-200 bg-[#FAF9F7] p-3 text-xs text-stone-700 shadow-xs space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <FilePlus className="h-3.5 w-3.5 shrink-0 text-amber-700" />
          <span className="font-semibold text-stone-900 truncate">{pageRequest.title}</span>
        </div>
        <button
          type="button"
          onClick={() => onNavigateRoute(pageRequest.route)}
          title={`Open ${pageRequest.route} in preview`}
          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-800 hover:bg-amber-100"
        >
          <span>{pageRequest.route}</span>
          <ArrowUpRight className="h-3 w-3" />
        </button>
      </div>

      {/* Metadata badges */}
      <div className="flex flex-wrap items-center gap-1.5">
        {isUnlisted && (
          <span className="inline-flex items-center gap-1 rounded-full bg-stone-200/80 px-2 py-0.5 text-[10px] font-medium text-stone-700">
            <EyeOff className="h-2.5 w-2.5" /> Unlisted
          </span>
        )}
        {pageRequest.nav.mode === 'group' && (
          <span className="rounded-full bg-white border border-stone-200 px-2 py-0.5 text-[10px] font-medium text-stone-600">
            Menu: {pageRequest.nav.group}
          </span>
        )}
        {pageRequest.styleLikeRoute && pageRequest.styleLikeRoute !== '__blank__' && (
          <span className="rounded-full bg-white border border-stone-200 px-2 py-0.5 text-[10px] text-stone-600">
            Styled like <span className="font-mono">{pageRequest.styleLikeRoute}</span>
          </span>
        )}
      </div>

      {pageRequest.attachment && (
        <div className="flex items-center gap-2 rounded-lg border border-stone-200/80 bg-white px-2 py-1.5">
          {pageRequest.attachment.thumbnailDataUrl && (
            <img
              src={pageRequest.attachment.thumbnailDataUrl}
              alt=""
              className="h-7 w-7 rounded object-cover shrink-0"
            />
          )}
          <span className="truncate text-[11px] text-stone-600">{pageRequest.attachment.filename}</span>
        </div>
      )}

      {pageRequest.purpose && (
        <p className="text-[12px] leading-relaxed text-stone-600 whitespace-pre-wrap">
          {pageRequest.purpose}
        </p>
      )}

      {/* Status bar */}
      <div
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
          pageRequest.status === 'done'
            ? 'bg-emerald-50 text-emerald-800'
            : pageRequest.status === 'failed'
              ? 'bg-red-50 text-red-800'
              : pageRequest.status === 'capped'
                ? 'bg-amber-50 text-amber-900'
                : 'bg-white border border-stone-200/80 text-stone-700'
        }`}
      >
        {isWorking && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-700" />}
        {pageRequest.status === 'queued' && <Clock className="h-3 w-3 shrink-0 text-stone-500" />}
        {pageRequest.status === 'done' && <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" />}
        {(pageRequest.status === 'failed' || pageRequest.status === 'capped') && (
          <AlertTriangle className="h-3 w-3 shrink-0" />
        )}
        <span className="min-w-0">
          {pageRequest.status === 'failed' && pageRequest.error
            ? pageRequest.error
            : pageStatusText(pageRequest.status)}
        </span>
      </div>

      {/* Recovery actions on failed or capped */}
      {canEdit && (pageRequest.status === 'failed' || pageRequest.status === 'capped') && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button
            type="button"
            disabled={busyAction !== null || (pageRequest.status === 'capped' && spendCapped)}
            onClick={async () => {
              setBusyAction('retry');
              try {
                await onRetry(pageRequest.pageRequestId);
              } finally {
                setBusyAction(null);
              }
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-stone-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
          >
            {busyAction === 'retry' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            Retry writing content
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={async () => {
              setBusyAction('delete');
              try {
                await onDelete(pageRequest.route);
              } finally {
                setBusyAction(null);
              }
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
          >
            {busyAction === 'delete' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            Delete page
          </button>
        </div>
      )}

      {/* Developer persona expandable raw instructions */}
      {persona === 'developer' && pageRequest.instructions && (
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => setShowInstructions((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-stone-500 hover:text-stone-800"
          >
            {showInstructions ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Instructions sent to Halley
          </button>
          {showInstructions && (
            <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-stone-200 bg-white p-2 font-mono text-[10px] leading-relaxed text-stone-600 whitespace-pre-wrap">
              {pageRequest.instructions}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
