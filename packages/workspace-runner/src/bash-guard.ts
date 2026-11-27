import path from 'node:path';

export type BashGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

const PROCESS_KILL_RE =
  /(?:^|[;&|(\n`]|\b(?:sudo|env|nohup|timeout|nice|xargs)\s+)(?:\s*\/(?:usr\/)?(?:s?bin)\/)?(?:kill|pkill|killall|fuser)\b/i;

const DEV_SERVER_RE =
  /(?:^|[;&|(\n`])\s*(?:(?:npx|pnpm(?:\s+exec)?|npm\s+(?:run|exec)|yarn)\s+)?(?:astro\s+(?:dev|preview)\b|vite(?:\s|$))/i;

const DIRECT_BUILD_OR_CHECK_RE =
  /(?:^|[;&|(\n`])\s*(?:(?:npx|pnpm(?:\s+(?:exec|run))?|npm\s+run|yarn)\s+)?(?:astro\s+(?:build|check)\b|(?:npm|pnpm|yarn)\s+run\s+(?:build|check)\b)/i;

// Unquoted parent-directory path arguments (e.g. `ls ../state`, `cd ..`, `cat ../../etc/passwd`)
const UNQUOTED_PARENT_PATH_RE = /(?:^|[\s=:(;|&])\.\.(?:\/|[\s;|&)]|$)/;

// Quoted parent-directory path arguments on filesystem commands (allows quoted search/filter strings on `rg`/`grep`/`jq`/`node -e`)
const QUOTED_FS_PARENT_PATH_RE =
  /(?:^|[;&|(\n`])\s*(?:cd|ls|cat|head|tail|rm|mv|cp|mkdir|rmdir|touch|ln|chmod|chown|sed|find)\b[^\n;|&`]*['"]\.\.(?:\/|['"])/i;

const DEP_MUTATION_RE =
  /(?:^|[;&|(\n`])\s*(?:npm\s+(?:install|i|ci|uninstall|rm|remove|update|up|dedupe|pkg|exec)\b|npx\b|pnpm\s+(?:add|install|i|remove|rm|uninstall|update|up|dlx)\b|yarn\s+(?:add|install|remove|upgrade|dlx)\b|corepack\b)/i;

/**
 * High-trust safety rails preventing accidental agent footguns on the shared workspace server:
 * - Process-killing commands (`kill`, `pkill`, `killall`, `fuser`)
 * - Starting duplicate dev/preview servers (`astro dev` is managed by Halley)
 * - Running unqueued `astro build` / `astro check` directly (use `run_checks` instead)
 * - Escaping the session working directory (`../state`, `/workspaces/sessions/other`), while
 *   allowing quoted search/filter patterns such as `rg "../lib/url" src/` and `jq '..'`.
 */
export function checkSharedContainerBashCommand(
  command: string,
  repoRoot: string,
): BashGuardResult {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: true };

  if (PROCESS_KILL_RE.test(trimmed)) {
    return {
      allowed: false,
      reason:
        'Process management commands (`kill`, `pkill`, `killall`, `fuser`) are disabled on the shared workspace server. Halley manages `astro dev` automatically.',
    };
  }

  if (DEV_SERVER_RE.test(trimmed)) {
    return {
      allowed: false,
      reason:
        'Starting dev/preview servers via `bash` is disabled because Halley already runs and manages `astro dev` for this session.',
    };
  }

  if (DIRECT_BUILD_OR_CHECK_RE.test(trimmed)) {
    return {
      allowed: false,
      reason:
        'Use the `run_checks` tool instead of running `astro build` / `astro check` / `npm run build` / `npm run check` via `bash` so verification is coordinated through the shared workspace build queue.',
    };
  }

  // Strip quoted strings before testing UNQUOTED_PARENT_PATH_RE so `rg "../lib/url" src/` and `jq '..'` pass!
  const withoutQuotedLiterals = trimmed
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'[^']*'/g, "''");

  if (UNQUOTED_PARENT_PATH_RE.test(withoutQuotedLiterals) || QUOTED_FS_PARENT_PATH_RE.test(trimmed)) {
    return {
      allowed: false,
      reason:
        'Parent-directory traversal (`..`) outside the repository is blocked on the shared workspace server. Stay within your current working directory.',
    };
  }

  // Block absolute references into /workspaces/, /halley-volume/, or /data/ outside repoRoot
  const resolvedRoot = path.resolve(repoRoot);
  const absPathMatches = trimmed.match(/\/(?:workspaces|halley-volume|data)\/[^\s"'`|;&)]*/g) ?? [];
  for (const rawAbs of absPathMatches) {
    const resolved = path.resolve(rawAbs);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      return {
        allowed: false,
        reason: `Accessing paths outside your session workspace (${rawAbs}) is blocked on the shared workspace server.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Returns true if the bash command may install, remove, or mutate packages in `node_modules`.
 * Used to trigger copy-on-change detachment before executing against a hardlinked/symlinked cache.
 */
export function isDependencyMutationCommand(command: string): boolean {
  return DEP_MUTATION_RE.test(command.trim());
}
