import type { PageRequestMetadata, TranscriptEntryDto } from '@halley/shared';
import { ChevronDown } from 'lucide-react';
import { memo } from 'react';
import { ChatMessageContent, parseUserMessageDisplay } from './ChatMessageContent.js';
import { NewPageCard } from './NewPageCard.js';

export type TranscriptDisplayBlock =
  | { kind: 'entry'; entry: TranscriptEntryDto }
  | { kind: 'steps'; id: string; items: TranscriptEntryDto[] };

export function groupTranscriptEntries(
  entries: TranscriptEntryDto[],
  collapseIntermediate: boolean,
): TranscriptDisplayBlock[] {
  if (!collapseIntermediate) {
    return entries.map((entry) => ({ kind: 'entry', entry }));
  }
  const blocks: TranscriptDisplayBlock[] = [];
  for (const entry of entries) {
    const isStep =
      (entry.role === 'tool' && !entry.pageRequest) ||
      (entry.role === 'assistant' && entry.isIntermediate);
    if (isStep) {
      const prev = blocks.at(-1);
      if (prev && prev.kind === 'steps') {
        prev.items.push(entry);
      } else {
        blocks.push({ kind: 'steps', id: `steps-${entry.id}`, items: [entry] });
      }
    } else {
      blocks.push({ kind: 'entry', entry });
    }
  }
  return blocks;
}

interface DesktopTranscriptBlocksProps {
  blocks: TranscriptDisplayBlock[];
  expandedTool: string | null;
  setExpandedTool: (id: string | null) => void;
  pageRequestsMap: Record<string, PageRequestMetadata>;
  liveUnlistedByRoute: Map<string, boolean>;
  knownRoutes: Set<string>;
  persona: 'non-technical' | 'developer';
  canEdit: boolean;
  spendCapped: boolean;
  astroBase: string;
  onNavigateRoute: (route: string) => void;
  onRetry: (pageRequestId: string) => Promise<void>;
  onDelete: (route: string) => Promise<void>;
}

/**
 * Desktop transcript list. Memoized so streaming `transcript_state` frames (which mostly change
 * `live.streamingText`) and unrelated editor state do not re-render every past message.
 */
export const DesktopTranscriptBlocks = memo(function DesktopTranscriptBlocks({
  blocks,
  expandedTool,
  setExpandedTool,
  pageRequestsMap,
  liveUnlistedByRoute,
  knownRoutes,
  persona,
  canEdit,
  spendCapped,
  astroBase,
  onNavigateRoute,
  onRetry,
  onDelete,
}: DesktopTranscriptBlocksProps) {
  return (
    <>
      {blocks.map((block) => {
        if (block.kind === 'steps') {
          const isOpen = expandedTool === block.id;
          const toolSteps = block.items.filter((i) => i.role === 'tool');
          const stepCount = toolSteps.length || block.items.length;
          return (
            <div key={block.id} className="rounded-lg border border-stone-200/80 bg-[#FAF9F7] px-3 py-1.5 text-xs">
              <button
                type="button"
                onClick={() => setExpandedTool(isOpen ? null : block.id)}
                className="flex w-full items-center justify-between text-stone-600"
              >
                <span className="font-medium">
                  {stepCount === 1
                    ? friendlyToolLabel(toolSteps[0]?.toolName)
                    : `Completed ${stepCount} steps`}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 transition ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              {isOpen && (
                <div className="mt-2 space-y-1.5 border-t border-stone-200/70 pt-2 text-[11px] text-stone-500">
                  {block.items.map((step) =>
                    step.role === 'tool' ? (
                      <div key={step.id} className="flex items-center justify-between gap-2">
                        <span className="font-medium text-stone-600">{friendlyToolLabel(step.toolName)}</span>
                        {step.toolStatus === 'error' && (
                          <span className="text-red-600 font-medium">issue</span>
                        )}
                      </div>
                    ) : (
                      <p key={step.id} className="text-stone-500 leading-relaxed">
                        {step.text}
                      </p>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        }
        const entry = block.entry;
        if (entry.role === 'user') {
          if (entry.pageRequest) {
            const livePr = pageRequestsMap[entry.pageRequest.pageRequestId] ?? entry.pageRequest;
            return (
              <NewPageCard
                key={entry.id}
                pageRequest={livePr}
                liveUnlisted={liveUnlistedByRoute.get(livePr.route)}
                persona={persona}
                canEdit={canEdit}
                spendCapped={spendCapped}
                onNavigateRoute={onNavigateRoute}
                onRetry={onRetry}
                onDelete={onDelete}
              />
            );
          }
          const parsed = parseUserMessageDisplay(entry.text);
          return (
            <div key={entry.id} className="flex flex-col items-end gap-1">
              {parsed.badges.length > 0 && (
                <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
                  {parsed.badges.map((b, idx) => (
                    <span
                      key={idx}
                      className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-900"
                    >
                      {b}
                    </span>
                  ))}
                </div>
              )}
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-stone-900 px-3.5 py-2.5 text-sm text-white whitespace-pre-wrap">
                {parsed.body}
              </div>
            </div>
          );
        }
        if (entry.role === 'tool') {
          if (entry.pageRequest) {
            const livePr = pageRequestsMap[entry.pageRequest.pageRequestId] ?? entry.pageRequest;
            return (
              <NewPageCard
                key={entry.id}
                pageRequest={livePr}
                liveUnlisted={liveUnlistedByRoute.get(livePr.route)}
                persona={persona}
                canEdit={canEdit}
                spendCapped={spendCapped}
                onNavigateRoute={onNavigateRoute}
                onRetry={onRetry}
                onDelete={onDelete}
              />
            );
          }
          const isOpen = expandedTool === entry.id;
          return (
            <div key={entry.id} className="rounded-lg border border-stone-200/80 bg-[#FAF9F7] px-3 py-1.5 text-xs">
              <button
                type="button"
                onClick={() => setExpandedTool(isOpen ? null : entry.id)}
                className="flex w-full items-center justify-between text-stone-600"
              >
                <span className="font-medium">{friendlyToolLabel(entry.toolName)}</span>
                <ChevronDown className={`h-3.5 w-3.5 transition ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              {isOpen && entry.toolOutput && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-stone-500">
                  {entry.toolOutput}
                </pre>
              )}
            </div>
          );
        }
        return (
          <div key={entry.id}>
            <ChatMessageContent
              text={entry.text}
              onNavigateRoute={onNavigateRoute}
              knownRoutes={knownRoutes}
              astroBase={astroBase}
            />
          </div>
        );
      })}
    </>
  );
});

export function friendlyToolLabel(name?: string): string {
  switch (name) {
    case 'read':
      return 'Read file';
    case 'edit':
    case 'write':
      return 'Updated file';
    case 'create_page':
      return 'Created starter page';
    case 'bash':
      return 'Ran command';
    case 'process_image':
      return 'Optimized image';
    case 'screenshot_page':
      return 'Inspected page layout';
    case 'run_checks':
      return 'Checked site health';
    default:
      return name || 'Step';
  }
}
