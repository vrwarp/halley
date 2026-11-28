import { friendlyElementKind } from '@halley/shared';
import { ArrowUpRight, ExternalLink } from 'lucide-react';
import React, { memo } from 'react';

const IGNORED_PATH_PREFIXES = ['/images/', '/api/', '/p/', '/src/', '/public/', '/node_modules/', '/internal/', '/ws/'];
const FILE_EXT_RE = /\.(?:astro|tsx?|jsx?|mjs|cjs|json|css|scss|html|md|mdx|webp|png|jpe?g|gif|svg|pdf|yml|yaml|sh|lock|txt)$/i;

function isNavigableSiteRoute(raw: string, knownRoutes?: Set<string>): boolean {
  if (!raw.startsWith('/') || raw.startsWith('//')) return false;
  const clean = raw.split(/[?#]/)[0] || '/';
  if (knownRoutes?.has(clean)) return true;
  if (clean === '/') return false; // only link bare `/` if explicitly in knownRoutes or markdown link
  if (IGNORED_PATH_PREFIXES.some((p) => clean.startsWith(p))) return false;
  if (FILE_EXT_RE.test(clean)) return false;
  return /^\/[a-z0-9][a-z0-9/_-]*$/i.test(clean);
}

interface InlineProps {
  text: string;
  onNavigateRoute: (route: string) => void;
  knownRoutes?: Set<string>;
  astroBase?: string;
}

function extractPreviewRouteFromUrl(rawUrl: string, astroBase?: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const normalizedBase = astroBase && astroBase !== '/' ? astroBase.replace(/\/$/, '') : '';
    if (normalizedBase && (parsed.pathname === normalizedBase || parsed.pathname.startsWith(normalizedBase + '/'))) {
      return parsed.pathname.slice(normalizedBase.length) || '/';
    }
  } catch (err) {
    // Expected for relative / malformed URLs (new URL throws TypeError): not a preview link.
    if (!(err instanceof TypeError)) throw err;
  }
  return null;
}

function renderInline({ text, onNavigateRoute, knownRoutes, astroBase }: InlineProps): React.ReactNode[] {
  // Matches: [label](href) | `code` | **bold** | *italic* | bare https:// URL | bare /route
  const tokenRe =
    /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|(https?:\/\/[^\s)<>]+)|(?<![a-zA-Z0-9:/._-])(\/[a-zA-Z0-9][a-zA-Z0-9/_-]*)/g;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const [full, linkLabel, linkHref, codeText, boldText, italicText, bareUrl, bareRoute] = match;

    if (linkLabel && linkHref) {
      const previewFromExternal = /^https?:\/\//i.test(linkHref)
        ? extractPreviewRouteFromUrl(linkHref, astroBase)
        : null;
      if (linkHref.startsWith('/') || previewFromExternal) {
        const cleanRoute = previewFromExternal ?? (linkHref.split(/[?#]/)[0] || '/');
        nodes.push(
          <button
            key={key++}
            type="button"
            onClick={() => onNavigateRoute(cleanRoute)}
            title={`Open ${cleanRoute} in preview`}
            className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 underline decoration-amber-400/70 underline-offset-2 transition hover:bg-amber-100 hover:text-amber-950"
          >
            <span>{linkLabel}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0" />
          </button>,
        );
      } else if (/^https?:\/\//i.test(linkHref)) {
        nodes.push(
          <a
            key={key++}
            href={linkHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-medium text-amber-800 underline decoration-amber-400/70 underline-offset-2 hover:text-amber-950"
          >
            <span>{linkLabel}</span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>,
        );
      } else {
        nodes.push(full);
      }
    } else if (codeText !== undefined) {
      const trimmed = codeText.trim();
      if (isNavigableSiteRoute(trimmed, knownRoutes)) {
        const cleanRoute = trimmed.split(/[?#]/)[0] || '/';
        nodes.push(
          <button
            key={key++}
            type="button"
            onClick={() => onNavigateRoute(cleanRoute)}
            title={`Open ${cleanRoute} in preview`}
            className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-xs font-medium text-amber-800 transition hover:bg-amber-100 hover:text-amber-950"
          >
            <span>{cleanRoute}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0" />
          </button>,
        );
      } else {
        nodes.push(
          <code
            key={key++}
            className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[12px] text-stone-800"
          >
            {codeText}
          </code>,
        );
      }
    } else if (boldText !== undefined) {
      nodes.push(
        <strong key={key++} className="font-semibold text-stone-900">
          {renderInline({ text: boldText, onNavigateRoute, knownRoutes, astroBase })}
        </strong>,
      );
    } else if (italicText !== undefined) {
      nodes.push(
        <em key={key++} className="italic">
          {italicText}
        </em>,
      );
    } else if (bareUrl !== undefined) {
      const cleanUrl = bareUrl.replace(/[.,;:!?]+$/, '');
      const trailing = bareUrl.slice(cleanUrl.length);
      const previewRoute = extractPreviewRouteFromUrl(cleanUrl, astroBase);
      if (previewRoute) {
        nodes.push(
          <button
            key={key++}
            type="button"
            onClick={() => onNavigateRoute(previewRoute)}
            title={`Open ${previewRoute} in preview`}
            className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-xs font-medium text-amber-800 transition hover:bg-amber-100 hover:text-amber-950"
          >
            <span>{previewRoute}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0" />
          </button>,
        );
      } else {
        nodes.push(
          <a
            key={key++}
            href={cleanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-medium text-amber-800 underline decoration-amber-400/70 underline-offset-2 hover:text-amber-950 break-all"
          >
            <span>{cleanUrl}</span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>,
        );
      }
      if (trailing) nodes.push(trailing);
    } else if (bareRoute !== undefined) {
      if (isNavigableSiteRoute(bareRoute, knownRoutes)) {
        nodes.push(
          <button
            key={key++}
            type="button"
            onClick={() => onNavigateRoute(bareRoute)}
            title={`Open ${bareRoute} in preview`}
            className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-xs font-medium text-amber-800 transition hover:bg-amber-100 hover:text-amber-950"
          >
            <span>{bareRoute}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0" />
          </button>,
        );
      } else {
        nodes.push(bareRoute);
      }
    } else {
      nodes.push(full);
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

/** Memoized: re-parses only when its text / routes / handler identity change. */
export const ChatMessageContent = memo(function ChatMessageContent({
  text,
  onNavigateRoute,
  knownRoutes,
  astroBase,
}: {
  text: string;
  onNavigateRoute: (route: string) => void;
  knownRoutes?: Set<string>;
  astroBase?: string;
}) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    // Bullet list
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*•]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={blocks.length} className="list-disc space-y-1 pl-4">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline({ text: item, onNavigateRoute, knownRoutes, astroBase })}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={blocks.length} className="list-decimal space-y-1 pl-4">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline({ text: item, onNavigateRoute, knownRoutes, astroBase })}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph (group consecutive non-empty, non-list lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*[-*•]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push(
      <p key={blocks.length} className="whitespace-pre-wrap">
        {renderInline({ text: paraLines.join('\n'), onNavigateRoute, knownRoutes, astroBase })}
      </p>,
    );
  }

  return <div className="space-y-2 text-sm leading-relaxed text-stone-800">{blocks}</div>;
});

/**
 * Strips internal `[Selected Element N] ...` and `[Uploaded Image] ...` lines from user transcript bubbles
 * so non-technical editors see clean context tags + their actual prompt.
 */
export function parseUserMessageDisplay(raw: string): {
  badges: string[];
  body: string;
} {
  const badges: string[] = [];
  const bodyLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('[Current Preview] ')) {
      continue;
    }
    const elMatch = line.match(
      /^\[Selected Element \d+\].*?tag=<([^>]+)>\s+text=("(?:\\.|[^"\\])*")(?:\s+highlighted=("(?:\\.|[^"\\])*"))?$/,
    );
    if (elMatch) {
      const kind = friendlyElementKind(elMatch[1] ?? 'div');
      let snippet = elMatch[3] ?? elMatch[2] ?? '';
      try {
        snippet = JSON.parse(snippet) as string;
      } catch (err) {
        // Expected: snippet is not a JSON string literal, keep it raw.
        if (!(err instanceof SyntaxError)) throw err;
      }
      badges.push(
        elMatch[3]
          ? `“${snippet.slice(0, 42)}”`
          : snippet
            ? `${kind}: ${snippet.slice(0, 42)}`
            : kind,
      );
      continue;
    }
    const imgMatch = line.match(/^\[Uploaded Image\].*?filename=(".*?")/);
    if (imgMatch) {
      let name = imgMatch[1] ?? 'Image';
      try {
        name = JSON.parse(name) as string;
      } catch (err) {
        // Expected: filename is not a JSON string literal, keep it raw.
        if (!(err instanceof SyntaxError)) throw err;
      }
      badges.push(`Image: ${name}`);
      continue;
    }
    bodyLines.push(line);
  }
  return {
    badges,
    body: bodyLines.join('\n').trim() || raw,
  };
}
