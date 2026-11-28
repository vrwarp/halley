import path from 'node:path';

export interface HalleyConfig {
  port: number;
  publicUrl: string;
  dataDir: string;
  repo: string; // owner/name
  baseBranch: string;
  /** Optional GitHub Actions workflow filename or name used to confirm live site deployment. */
  deployWorkflow: string;
  /**
   * Merge the publish PR as soon as it is opened instead of waiting for its CI run. The commit has
   * already passed Halley's local checks; if GitHub refuses the merge, Halley waits for CI as usual.
   */
  publishSkipCi: boolean;
  /** Optional override for live site URL used in Live vs Draft screenshots (defaults to https://<owner>.github.io/<repo> from HALLEY_REPO; "none" disables). */
  liveSiteUrl: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  githubAppInstallationId: string;
  githubToken: string;
  gitBotName: string;
  gitBotEmail: string;
  googleClientId: string;
  googleClientSecret: string;
  adminEmails: string[];
  allowedEmails: string[];
  allowedDomains: string[];
  sessionSecret: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  githubApiBaseUrl: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  conflictModelId: string;
  escalationModelId: string;
  escalationThinkingLevel: 'off' | 'low' | 'medium' | 'high';
  escalationMaxUsd: number;
  dailyCostCapUsd: number;
  workspaceHostUrl: string;
  workspaceHostSecret: string;
  maxActiveWorkspaces: number;
  controlPlaneInternalUrl: string;
  workspaceIdleTimeoutMs: number;
  browserIdleTimeoutMs: number;
  archiveRetentionDays: number;
  nodeModulesPruneDays: number;
  warmPoolSize: number;
  /** spend_events rows older than this are rolled up and deleted by the reaper. */
  spendEventRetentionDays: number;
  /** Online SQLite backup cadence (0 disables). */
  dbBackupIntervalMs: number;
  /** Number of daily backups kept in <dataDir>/backups. */
  dbBackupKeep: number;
  /** JSON API request body cap (bytes). */
  apiBodyLimitBytes: number;
  /** Upload route body cap (bytes); matches the runner's 25 MB upload limit. */
  uploadBodyLimitBytes: number;
  devLoginEnabled: boolean;
  devLocalRepo: string;
  webDistDir: string;
}

/**
 * Derives the default GitHub Pages URL for an `owner/repo` slug:
 * - Project site: `https://<owner>.github.io/<repo>`
 * - User/org site (`<owner>.github.io`): `https://<owner>.github.io`
 */
export function deriveGitHubPagesUrl(repo: string): string | null {
  const parts = repo.trim().split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repoName] = parts;
  if (!owner || !repoName) return null;
  const host = `${owner.toLowerCase()}.github.io`;
  if (repoName.toLowerCase() === host) {
    return `https://${host}`;
  }
  return `https://${host}/${repoName}`;
}

/**
 * Resolves the live site base URL used for Live vs Draft screenshots.
 * Precedence:
 * 1. `HALLEY_LIVE_SITE_URL` (`none`/`off` disables; any other value overrides)
 * 2. Derived GitHub Pages URL from `HALLEY_REPO` (`https://<owner>.github.io/<repo>`)
 * 3. Fallback to `detectedSiteUrl` from `astro.config.*` if `HALLEY_REPO` is not `owner/repo`
 */
export function resolveLiveSiteUrl(
  config: Pick<HalleyConfig, 'liveSiteUrl' | 'repo'>,
  detectedSiteUrl?: string | null,
): string | null {
  const envLive = config.liveSiteUrl.trim().replace(/\/+$/, '');
  if (envLive.toLowerCase() === 'none' || envLive.toLowerCase() === 'off') {
    return null;
  }
  if (envLive) {
    return envLive;
  }
  return deriveGitHubPagesUrl(config.repo) || detectedSiteUrl?.trim().replace(/\/+$/, '') || null;
}

function splitCsv(val: string | undefined): string[] {
  return (val ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Reads a numeric env var. Unset/empty → `fallback`. Anything else must be a finite number within
 * [min, max] (and an integer when `integer`), otherwise loadConfig fails loudly naming the variable:
 * a typo like `WORKSPACE_IDLE_TIMEOUT_MS=20m` used to become NaN and silently disable reaping.
 */
export function envNumber(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  const { min = -Infinity, max = Infinity, integer = false } = opts;
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    const range = [
      integer ? 'an integer' : 'a number',
      Number.isFinite(min) ? `>= ${min}` : '',
      Number.isFinite(max) ? `<= ${max}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    throw new ConfigError(`Invalid ${name}=${JSON.stringify(raw)}: expected ${range}`);
  }
  return value;
}

/** Default model ids (concrete, so a new alias target never changes behaviour or cost silently). */
export const DEFAULT_MODEL_ID = 'claude-haiku-5-5';
export const DEFAULT_ESCALATION_MODEL_ID = 'claude-opus-5-5';

export function loadConfig(): HalleyConfig {
  const port = envNumber('PORT', 3000, { min: 0, max: 65535, integer: true });
  const workspaceHostUrl = (process.env.WORKSPACE_HOST_URL || '').trim().replace(/\/+$/, '');
  const warmPoolSize = Math.min(
    3,
    envNumber('HALLEY_WARM_POOL_SIZE', workspaceHostUrl ? 1 : 0, { min: 0, integer: true }),
  );
  return {
    port,
    publicUrl: (process.env.HALLEY_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    repo: process.env.HALLEY_REPO || 'vrwarp/thecrossing.website',
    baseBranch: process.env.HALLEY_BASE_BRANCH || 'main',
    deployWorkflow: (process.env.HALLEY_DEPLOY_WORKFLOW || '').trim(),
    publishSkipCi: ['1', 'true', 'yes', 'on'].includes((process.env.HALLEY_PUBLISH_SKIP_CI || '').trim().toLowerCase()),
    liveSiteUrl: (process.env.HALLEY_LIVE_SITE_URL || '').trim().replace(/\/+$/, ''),
    githubAppId: process.env.GITHUB_APP_ID || '',
    githubAppPrivateKey: (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID || '',
    githubToken: process.env.GITHUB_TOKEN || '',
    gitBotName: process.env.HALLEY_GIT_BOT_NAME || 'Halley Bot',
    gitBotEmail: process.env.HALLEY_GIT_BOT_EMAIL || 'halley-bot@users.noreply.github.com',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    adminEmails: splitCsv(process.env.HALLEY_ADMIN_EMAILS),
    allowedEmails: splitCsv(process.env.HALLEY_ALLOWED_EMAILS),
    allowedDomains: splitCsv(process.env.HALLEY_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, '')),
    sessionSecret: process.env.SESSION_SECRET || 'halley-dev-insecure-secret',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
    githubApiBaseUrl: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    modelProvider: process.env.HALLEY_MODEL_PROVIDER || 'anthropic',
    // Concrete ids by default (aliases like 'haiku-latest' still work when configured explicitly)
    modelId: process.env.HALLEY_MODEL_ID || DEFAULT_MODEL_ID,
    thinkingLevel: (process.env.HALLEY_THINKING_LEVEL || 'high') as 'off' | 'low' | 'medium' | 'high',
    conflictModelId: process.env.HALLEY_CONFLICT_MODEL || process.env.HALLEY_MODEL_ID || DEFAULT_MODEL_ID,
    escalationModelId: process.env.HALLEY_ESCALATION_MODEL || DEFAULT_ESCALATION_MODEL_ID,
    escalationThinkingLevel: (process.env.HALLEY_ESCALATION_THINKING || 'medium') as
      | 'off'
      | 'low'
      | 'medium'
      | 'high',
    escalationMaxUsd: envNumber('HALLEY_ESCALATION_MAX_USD', 2, { min: 0 }),
    dailyCostCapUsd: envNumber('HALLEY_DAILY_COST_CAP_USD', 10, { min: 0 }),
    workspaceHostUrl,
    workspaceHostSecret: (process.env.WORKSPACE_HOST_SECRET || '').trim(),
    maxActiveWorkspaces: envNumber('MAX_ACTIVE_WORKSPACES', 5, { min: 1, integer: true }),
    controlPlaneInternalUrl:
      process.env.CONTROL_PLANE_INTERNAL_URL || `http://127.0.0.1:${port}`,
    workspaceIdleTimeoutMs: envNumber('WORKSPACE_IDLE_TIMEOUT_MS', 20 * 60_000, { min: 1000 }),
    browserIdleTimeoutMs: envNumber('HALLEY_BROWSER_IDLE_TIMEOUT_MS', 60 * 60_000, { min: 1000 }),
    archiveRetentionDays: envNumber('ARCHIVE_RETENTION_DAYS', 420, { min: 1 }),
    nodeModulesPruneDays: envNumber('NODE_MODULES_PRUNE_DAYS', 7, { min: 1 }),
    warmPoolSize,
    spendEventRetentionDays: envNumber('HALLEY_SPEND_EVENT_RETENTION_DAYS', 90, { min: 1, integer: true }),
    dbBackupIntervalMs: envNumber('HALLEY_DB_BACKUP_INTERVAL_MS', 24 * 60 * 60_000, { min: 0 }),
    dbBackupKeep: envNumber('HALLEY_DB_BACKUP_KEEP', 7, { min: 1, integer: true }),
    apiBodyLimitBytes: envNumber('HALLEY_API_BODY_LIMIT_BYTES', 1024 * 1024, { min: 1024, integer: true }),
    // Same knob and default as the runner's /internal/uploads cap, so both reject at the same size
    uploadBodyLimitBytes: envNumber('HALLEY_MAX_UPLOAD_MB', 25, { min: 1 }) * 1024 * 1024,
    devLoginEnabled: process.env.HALLEY_DEV_LOGIN === 'true',
    devLocalRepo: process.env.HALLEY_DEV_LOCAL_REPO || '',
    webDistDir: path.resolve(process.env.HALLEY_WEB_DIST || '../web/dist'),
  };
}
