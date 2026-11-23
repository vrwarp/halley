import path from 'node:path';

export interface HalleyConfig {
  port: number;
  publicUrl: string;
  dataDir: string;
  repo: string; // owner/name
  baseBranch: string;
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
  modelProvider: string;
  modelId: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  dailyCostCapUsd: number;
  workspaceDriver: 'docker' | 'local';
  workspaceImage: string;
  workspaceDockerNetwork: string;
  controlPlaneInternalUrl: string;
  workspaceIdleTimeoutMs: number;
  archiveRetentionDays: number;
  devLoginEnabled: boolean;
  devLocalRepo: string;
  webDistDir: string;
}

function splitCsv(val: string | undefined): string[] {
  return (val ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(): HalleyConfig {
  const port = Number(process.env.PORT || 3000);
  return {
    port,
    publicUrl: (process.env.HALLEY_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    repo: process.env.HALLEY_REPO || 'vrwarp/thecrossing.website',
    baseBranch: process.env.HALLEY_BASE_BRANCH || 'main',
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
    modelProvider: process.env.HALLEY_MODEL_PROVIDER || 'anthropic',
    modelId: process.env.HALLEY_MODEL_ID || 'haiku-latest',
    thinkingLevel: (process.env.HALLEY_THINKING_LEVEL || 'high') as 'off' | 'low' | 'medium' | 'high',
    dailyCostCapUsd: Number(process.env.HALLEY_DAILY_COST_CAP_USD || 10),
    workspaceDriver: process.env.WORKSPACE_DRIVER === 'local' ? 'local' : 'docker',
    workspaceImage: process.env.WORKSPACE_IMAGE || 'halley-workspace:latest',
    workspaceDockerNetwork: process.env.WORKSPACE_DOCKER_NETWORK || 'halley-net',
    controlPlaneInternalUrl:
      process.env.CONTROL_PLANE_INTERNAL_URL || `http://127.0.0.1:${port}`,
    workspaceIdleTimeoutMs: Number(process.env.WORKSPACE_IDLE_TIMEOUT_MS || 20 * 60_000),
    archiveRetentionDays: Number(process.env.ARCHIVE_RETENTION_DAYS || 7),
    devLoginEnabled: process.env.HALLEY_DEV_LOGIN === 'true',
    devLocalRepo: process.env.HALLEY_DEV_LOCAL_REPO || '',
    webDistDir: path.resolve(process.env.HALLEY_WEB_DIST || '../web/dist'),
  };
}
