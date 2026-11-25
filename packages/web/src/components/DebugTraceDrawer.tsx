import { useEffect, useMemo, useState } from 'react';
import type { DebugTraceDto, DebugTraceEntryDto } from '@halley/shared';
import {
  AlertCircle,
  Bug,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileCode2,
  FileJson,
  Loader2,
  RefreshCw,
  Wrench,
  X,
} from 'lucide-react';
import { api } from '../api.js';

interface Props {
  sessionId: string;
  sessionTitle: string;
  currentRoute: string;
  wsConnected: boolean;
  onClose: () => void;
}

type FilterMode = 'all' | 'prompts' | 'tools' | 'responses' | 'errors';

export function formatDebugTraceAsMarkdown(trace: DebugTraceDto, sessionTitle: string): string {
  const lines: string[] = [];
  lines.push(`# Halley Debug Trace — ${sessionTitle}`);
  lines.push('');
  lines.push(`- **Exported At:** ${trace.exportedAt}`);
  lines.push(`- **Session ID:** \`${trace.sessionId}\``);
  lines.push(`- **Model:** \`${trace.modelId}\` (thinking: \`${trace.thinkingLevel}\`)`);
  lines.push(`- **Persona:** \`${trace.persona}\``);
  lines.push(`- **Preview Base:** \`${trace.previewBase}\``);
  if (trace.lastEditorContext) {
    lines.push(
      `- **Last Preview Context:** route=\`${trace.lastEditorContext.currentRoute}\` viewport=\`${trace.lastEditorContext.viewport ?? 'desktop'}\` mode=\`${trace.lastEditorContext.mode ?? 'browse'}\``,
    );
  }
  lines.push(`- **Total Cost:** \$${trace.usageUsd.toFixed(4)}`);
  lines.push('');

  lines.push('## System Prompt (`halley_role`)');
  lines.push('');
  lines.push('```text');
  lines.push(trace.systemPrompt.halleyRole);
  lines.push('```');
  lines.push('');

  if (trace.systemPrompt.agentsMd) {
    lines.push('<details>');
    lines.push('<summary>Repository AGENTS.md</summary>');
    lines.push('');
    lines.push('```markdown');
    lines.push(trace.systemPrompt.agentsMd);
    lines.push('```');
    lines.push('</details>');
    lines.push('');
  }

  lines.push(`## Conversation Thread (${trace.entries.length} entries)`);
  lines.push('');

  trace.entries.forEach((entry, idx) => {
    const num = idx + 1;
    if (entry.role === 'user') {
      lines.push(`### ${num}. User Prompt (id: \`${entry.id}\`)`);
      if (entry.imagesCount) {
        lines.push(`_Attached images: ${entry.imagesCount}_`);
      }
      lines.push('');
      lines.push('```text');
      lines.push(entry.text ?? '');
      lines.push('```');
      lines.push('');
    } else if (entry.role === 'assistant') {
      const meta = [entry.model, entry.stopReason].filter(Boolean).join(' · ');
      lines.push(`### ${num}. Assistant${meta ? ` (${meta})` : ''} (id: \`${entry.id}\`)`);
      lines.push('');
      if (entry.thinking) {
        lines.push('<details>');
        lines.push('<summary>Thinking</summary>');
        lines.push('');
        lines.push('```text');
        lines.push(entry.thinking);
        lines.push('```');
        lines.push('</details>');
        lines.push('');
      }
      if (entry.text) {
        lines.push(entry.text);
        lines.push('');
      }
      if (entry.toolCalls && entry.toolCalls.length > 0) {
        for (const call of entry.toolCalls) {
          lines.push(`**Tool Call:** \`${call.name}\`${call.id ? ` (\`${call.id}\`)` : ''}`);
          lines.push('');
          lines.push('```json');
          lines.push(JSON.stringify(call.arguments ?? {}, null, 2));
          lines.push('```');
          lines.push('');
        }
      }
    } else if (entry.role === 'tool') {
      const status = entry.isError ? 'ERROR' : 'OK';
      lines.push(
        `### ${num}. Tool Result: \`${entry.toolName ?? 'tool'}\` [${status}]${entry.toolCallId ? ` (\`${entry.toolCallId}\`)` : ''}`,
      );
      lines.push('');
      lines.push('```text');
      lines.push(entry.toolOutput ?? '');
      lines.push('```');
      lines.push('');
    }
  });

  if (Object.keys(trace.usageByModel).length > 0) {
    lines.push('## Usage By Model');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(trace.usageByModel, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (trace.recentLogs && trace.recentLogs.length > 0) {
    lines.push(`## Recent Workspace Logs (${trace.recentLogs.length} lines)`);
    lines.push('');
    lines.push('```text');
    lines.push(trace.recentLogs.join('\n'));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

function triggerDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeSlug(str: string): string {
  return (
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'session'
  );
}

export function DebugTraceDrawer({
  sessionId,
  sessionTitle,
  currentRoute,
  wsConnected,
  onClose,
}: Props) {
  const [trace, setTrace] = useState<DebugTraceDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [showAgentsMd, setShowAgentsMd] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadTrace = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getDebugTrace(sessionId);
      setTrace(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load debug trace');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTrace();
  }, [sessionId]);

  const filteredEntries = useMemo(() => {
    if (!trace) return [];
    return trace.entries.filter((e) => {
      if (filter === 'all') return true;
      if (filter === 'prompts') return e.role === 'user';
      if (filter === 'tools') return e.role === 'tool' || Boolean(e.toolCalls?.length);
      if (filter === 'responses') return e.role === 'assistant' && Boolean(e.text);
      if (filter === 'errors') return e.role === 'tool' && Boolean(e.isError);
      return true;
    });
  }, [trace, filter]);

  const counts = useMemo(() => {
    const entries = trace?.entries ?? [];
    return {
      all: entries.length,
      prompts: entries.filter((e) => e.role === 'user').length,
      tools: entries.filter((e) => e.role === 'tool' || Boolean(e.toolCalls?.length)).length,
      responses: entries.filter((e) => e.role === 'assistant' && Boolean(e.text)).length,
      errors: entries.filter((e) => e.role === 'tool' && Boolean(e.isError)).length,
    };
  }, [trace]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleDownloadJson = () => {
    if (!trace) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    triggerDownload(
      `halley-trace-${safeSlug(sessionTitle)}-${stamp}.json`,
      JSON.stringify(trace, null, 2),
      'application/json;charset=utf-8',
    );
  };

  const handleDownloadMarkdown = () => {
    if (!trace) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    triggerDownload(
      `halley-trace-${safeSlug(sessionTitle)}-${stamp}.md`,
      formatDebugTraceAsMarkdown(trace, sessionTitle),
      'text/markdown;charset=utf-8',
    );
  };

  const handleCopyMarkdown = () => {
    if (!trace) return;
    void handleCopy('all-md', formatDebugTraceAsMarkdown(trace, sessionTitle));
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-stone-950/40 backdrop-blur-[1px]">
      <div className="flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl border-l border-stone-200">
        {/* Header */}
        <div
          className="flex flex-wrap items-center justify-between gap-2.5 border-b border-stone-200 bg-stone-50 px-4 py-3 sm:px-5 sm:py-3.5"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-900 text-white">
              <Bug className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-stone-900 truncate">
                Agent Debug Trace
              </h2>
              <p className="text-[11px] text-stone-500 truncate">
                Full prompts, tool calls, outputs &amp; responses for &ldquo;{sessionTitle}&rdquo;
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void loadTrace()}
              disabled={loading}
              title="Refresh trace"
              className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button
              type="button"
              onClick={handleCopyMarkdown}
              disabled={!trace}
              title="Copy full thread as Markdown"
              className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            >
              {copiedId === 'all-md' ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copiedId === 'all-md' ? 'Copied' : 'Copy MD'}
            </button>
            <button
              type="button"
              onClick={handleDownloadMarkdown}
              disabled={!trace}
              title="Download full thread as Markdown (.md)"
              className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            >
              <FileCode2 className="h-3.5 w-3.5" />
              .md
            </button>
            <button
              type="button"
              onClick={handleDownloadJson}
              disabled={!trace}
              title="Download raw structured trace as JSON (.json)"
              className="inline-flex items-center gap-1 rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-50"
            >
              <FileJson className="h-3.5 w-3.5" />
              <Download className="h-3 w-3" />
              .json
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close debug panel"
              className="ml-1 flex h-9 w-9 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-200/70 hover:text-stone-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Metadata strip */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-stone-200 bg-white px-4 py-2.5 text-[11px] text-stone-600 sm:px-5">
          <span>
            <strong className="text-stone-800">Route:</strong>{' '}
            <code className="font-mono text-stone-700">{currentRoute}</code>
          </span>
          <span>
            <strong className="text-stone-800">Transport:</strong>{' '}
            <span className={wsConnected ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
              {wsConnected ? 'WebSocket' : 'HTTP polling fallback'}
            </span>
          </span>
          {trace && (
            <>
              <span>
                <strong className="text-stone-800">Model:</strong>{' '}
                <code className="font-mono">{trace.modelId}</code> ({trace.thinkingLevel})
              </span>
              <span>
                <strong className="text-stone-800">Tone:</strong> {trace.persona}
              </span>
              <span>
                <strong className="text-stone-800">Cost:</strong> ${trace.usageUsd.toFixed(4)}
              </span>
            </>
          )}
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-stone-50/70 px-4 py-2 sm:px-5">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ['all', `All (${counts.all})`],
                ['prompts', `Prompts (${counts.prompts})`],
                ['tools', `Tools (${counts.tools})`],
                ['responses', `Responses (${counts.responses})`],
                ['errors', `Errors (${counts.errors})`],
              ] as Array<[FilterMode, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                  filter === key
                    ? 'bg-stone-900 text-white'
                    : 'text-stone-600 hover:bg-stone-200/70 hover:text-stone-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {trace && (
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => setShowSystemPrompt((v) => !v)}
                className="inline-flex items-center gap-1 rounded border border-stone-200 bg-white px-2 py-1 font-medium text-stone-700 hover:bg-stone-100"
              >
                System prompt
                <ChevronDown className={`h-3 w-3 transition ${showSystemPrompt ? 'rotate-180' : ''}`} />
              </button>
              {trace.systemPrompt.agentsMd && (
                <button
                  type="button"
                  onClick={() => setShowAgentsMd((v) => !v)}
                  className="inline-flex items-center gap-1 rounded border border-stone-200 bg-white px-2 py-1 font-medium text-stone-700 hover:bg-stone-100"
                >
                  AGENTS.md
                  <ChevronDown className={`h-3 w-3 transition ${showAgentsMd ? 'rotate-180' : ''}`} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-[#FAF9F7]">
          {loading && !trace && (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading full agent trace…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Couldn&apos;t load debug trace</p>
                <p className="mt-0.5 text-red-700">{error}</p>
              </div>
            </div>
          )}

          {trace && showSystemPrompt && (
            <div className="rounded-xl border border-stone-200 bg-white p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                  System Prompt · halley_role
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopy('sys', trace.systemPrompt.halleyRole)}
                  className="inline-flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-900"
                >
                  {copiedId === 'sys' ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                  {copiedId === 'sys' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-stone-700">
                {trace.systemPrompt.halleyRole}
              </pre>
            </div>
          )}

          {trace && showAgentsMd && trace.systemPrompt.agentsMd && (
            <div className="rounded-xl border border-stone-200 bg-white p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                  Repository AGENTS.md
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopy('agents', trace.systemPrompt.agentsMd ?? '')}
                  className="inline-flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-900"
                >
                  {copiedId === 'agents' ? (
                    <Check className="h-3 w-3 text-emerald-600" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedId === 'agents' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-stone-700">
                {trace.systemPrompt.agentsMd}
              </pre>
            </div>
          )}

          {trace && filteredEntries.length === 0 && (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-xs text-stone-500">
              No entries match this filter yet.
            </div>
          )}

          {filteredEntries.map((entry, idx) => (
            <TraceEntryCard
              key={entry.id}
              entry={entry}
              index={idx + 1}
              copiedId={copiedId}
              onCopy={handleCopy}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TraceEntryCard({
  entry,
  index,
  copiedId,
  onCopy,
}: {
  entry: DebugTraceEntryDto;
  index: number;
  copiedId: string | null;
  onCopy: (id: string, text: string) => void;
}) {
  if (entry.role === 'user') {
    const rawText = entry.text ?? '';
    const lines = rawText.split('\n');
    const contextLines: string[] = [];
    const bodyLines: string[] = [];
    let inHeader = true;
    for (const line of lines) {
      if (
        inHeader &&
        (line.startsWith('[Current Preview] ') ||
          line.startsWith('[Selected Element ') ||
          line.startsWith('[Uploaded Image] ') ||
          line.trim() === '')
      ) {
        if (line.trim() !== '') contextLines.push(line);
      } else {
        inHeader = false;
        bodyLines.push(line);
      }
    }
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-3.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="rounded bg-stone-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
              USER #{index}
            </span>
            <span className="font-mono text-[10px] text-stone-400">id={entry.id}</span>
            {entry.imagesCount ? (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                {entry.imagesCount} image{entry.imagesCount > 1 ? 's' : ''}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onCopy(entry.id, rawText)}
            className="inline-flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-800"
          >
            {copiedId === entry.id ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
            Copy
          </button>
        </div>

        {contextLines.length > 0 && (
          <div className="rounded-lg border border-amber-200/80 bg-amber-50/70 px-2.5 py-2 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-800">
              Injected Context
            </p>
            {contextLines.map((cl, i) => (
              <pre key={i} className="whitespace-pre-wrap break-all font-mono text-[11px] text-amber-950">
                {cl}
              </pre>
            ))}
          </div>
        )}

        <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-stone-800">
          {bodyLines.join('\n').trim() || rawText}
        </pre>
      </div>
    );
  }

  if (entry.role === 'assistant') {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-3.5 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-amber-600 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
              ASSISTANT #{index}
            </span>
            {entry.model && <span className="font-mono text-[10px] text-stone-500">{entry.model}</span>}
            {entry.stopReason && (
              <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600">
                stop={entry.stopReason}
              </span>
            )}
          </div>
          {entry.text && (
            <button
              type="button"
              onClick={() => onCopy(entry.id, entry.text ?? '')}
              className="inline-flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-800"
            >
              {copiedId === entry.id ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
              Copy
            </button>
          )}
        </div>

        {entry.thinking && (
          <details className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-medium text-stone-600">
              Thinking ({entry.thinking.length.toLocaleString()} chars)
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-stone-600">
              {entry.thinking}
            </pre>
          </details>
        )}

        {entry.text && (
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-stone-800">
            {entry.text}
          </pre>
        )}

        {entry.toolCalls && entry.toolCalls.length > 0 && (
          <div className="space-y-2">
            {entry.toolCalls.map((call, i) => (
              <div
                key={call.id || `${entry.id}-call-${i}`}
                className="rounded-lg border border-indigo-200/80 bg-indigo-50/40 p-2.5"
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <Wrench className="h-3.5 w-3.5 text-indigo-700" />
                    <code className="font-mono text-[11px] font-semibold text-indigo-950">
                      {call.name}
                    </code>
                    {call.id && (
                      <span className="font-mono text-[10px] text-indigo-500">{call.id}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      onCopy(`${entry.id}-call-${i}`, JSON.stringify(call.arguments ?? {}, null, 2))
                    }
                    className="inline-flex items-center gap-1 text-[10px] text-indigo-600 hover:text-indigo-900"
                  >
                    {copiedId === `${entry.id}-call-${i}` ? (
                      <Check className="h-3 w-3 text-emerald-600" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    Args
                  </button>
                </div>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-stone-800">
                  {JSON.stringify(call.arguments ?? {}, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Tool result
  const out = entry.toolOutput ?? '';
  return (
    <div
      className={`rounded-xl border p-3 ${
        entry.isError ? 'border-red-200 bg-red-50/50' : 'border-stone-200 bg-stone-50/70'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
              entry.isError ? 'bg-red-600 text-white' : 'bg-stone-700 text-white'
            }`}
          >
            TOOL RESULT · {entry.toolName ?? 'tool'}
          </span>
          {entry.toolCallId && (
            <span className="font-mono text-[10px] text-stone-400">{entry.toolCallId}</span>
          )}
          <span className="font-mono text-[10px] text-stone-400">
            {out.length.toLocaleString()} chars
          </span>
        </div>
        <button
          type="button"
          onClick={() => onCopy(entry.id, out)}
          className="inline-flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-900"
        >
          {copiedId === entry.id ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          Copy output
        </button>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-stone-700">
        {out || '(empty output)'}
      </pre>
    </div>
  );
}
