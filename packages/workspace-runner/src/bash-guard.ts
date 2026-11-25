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

const PARENT_TRAVERSAL_RE = /(?:^|[\s"'=:,;({/])\.\.(?:\/|[\s"'=:,;)}]|$)/;

const DEP_MUTATION_RE =
  /(?:^|[;&|(\n`])\s*(?:npm\s+(?:install|i|ci|uninstall|rm|remove|update|up|dedupe|pkg)\b|pnpm\s+(?:add|install|i|remove|rm|uninstall|update|up)\b|yarn\s+(?:add|install|remove|upgrade)\b)/i;

/**
 * Checks whether a bash command is safe to run inside the shared workspaces container.
 * Blocks process-killing commands, dev-server launches, parent-directory traversal
 * outside the session repo, and direct build/check runs (which should use `run_checks`
 * so the container-wide FIFO build queue governs peak RAM).
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

  if (PARENT_TRAVERSAL_RE.test(trimmed)) {
    return {
      allowed: false,
      reason:
        'Parent-directory traversal (`..`) is blocked on the shared workspace server. Stay strictly within your current working directory.',
    };
  }

  // Block absolute references into /workspaces/ or other session directories outside repoRoot
  const resolvedRoot = path.resolve(repoRoot);
  const workspacesParent = path.dirname(path.dirname(resolvedRoot)); // e.g. /workspaces/sessions -> /workspaces
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
  void workspacesParent;

  return { allowed: true };
}

/**
 * Returns true if the bash command may install, remove, or mutate packages in `node_modules`.
 * Used to trigger copy-on-change detachment before executing against a hardlinked cache.
 */
export function isDependencyMutationCommand(command: string): boolean {
  return DEP_MUTATION_RE.test(command.trim());
}
