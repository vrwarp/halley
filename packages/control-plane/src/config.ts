import path from 'node:path';

export interface HalleyConfig {
  port: number;
  publicUrl: string;
  dataDir: string;
  repo: string; // owner/name
  baseBranch: string;
  /** Optional GitHub Actions workflow filename or name used to confirm live site deployment. */
  deployWorkflow: string;
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

export function loadConfig(): HalleyConfig {
  const port = Number(process.env.PORT || 3000);
  const workspaceHostUrl = (process.env.WORKSPACE_HOST_URL || '').trim().replace(/\/+$/, '');
  const warmPoolRaw = process.env.HALLEY_WARM_POOL_SIZE;
  const warmPoolSize =
    warmPoolRaw !== undefined && warmPoolRaw !== ''
      ? Math.max(0, Math.min(3, Number(warmPoolRaw) || 0))
      : workspaceHostUrl
        ? 1
        : 0;
  return {
    port,
    publicUrl: (process.env.HALLEY_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    repo: process.env.HALLEY_REPO || 'vrwarp/thecrossing.website',
    baseBranch: process.env.HALLEY_BASE_BRANCH || 'main',
    deployWorkflow: (process.env.HALLEY_DEPLOY_WORKFLOW || '').trim(),
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
    modelId: process.env.HALLEY_MODEL_ID || 'haiku-latest',
    thinkingLevel: (process.env.HALLEY_THINKING_LEVEL || 'high') as 'off' | 'low' | 'medium' | 'high',
    conflictModelId: process.env.HALLEY_CONFLICT_MODEL || process.env.HALLEY_MODEL_ID || 'haiku-latest',
    escalationModelId: process.env.HALLEY_ESCALATION_MODEL || 'opus-latest',
    escalationThinkingLevel: (process.env.HALLEY_ESCALATION_THINKING || 'medium') as
      | 'off'
      | 'low'
      | 'medium'
      | 'high',
    escalationMaxUsd: Number(process.env.HALLEY_ESCALATION_MAX_USD || 2),
    dailyCostCapUsd: Number(process.env.HALLEY_DAILY_COST_CAP_USD || 10),
    workspaceHostUrl,
    workspaceHostSecret: (process.env.WORKSPACE_HOST_SECRET || '').trim(),
    maxActiveWorkspaces: Math.max(1, Number(process.env.MAX_ACTIVE_WORKSPACES || 5) || 5),
    controlPlaneInternalUrl:
      process.env.CONTROL_PLANE_INTERNAL_URL || `http://127.0.0.1:${port}`,
    workspaceIdleTimeoutMs: Number(process.env.WORKSPACE_IDLE_TIMEOUT_MS || 20 * 60_000),
    browserIdleTimeoutMs: Number(process.env.HALLEY_BROWSER_IDLE_TIMEOUT_MS || 60 * 60_000),
    archiveRetentionDays: Number(process.env.ARCHIVE_RETENTION_DAYS || 420),
    nodeModulesPruneDays: Number(process.env.NODE_MODULES_PRUNE_DAYS || 7),
    warmPoolSize,
    devLoginEnabled: process.env.HALLEY_DEV_LOGIN === 'true',
    devLocalRepo: process.env.HALLEY_DEV_LOCAL_REPO || '',
    webDistDir: path.resolve(process.env.HALLEY_WEB_DIST || '../web/dist'),
  };
}
