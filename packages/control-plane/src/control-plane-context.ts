/**
 * The explicit, typed context route modules receive from the composition root
 * (createControlPlane in index.ts). Each module exports `register(app, ctx)`.
 */
import type { BootProgressDto, ChatServerMessage, UserDto } from '@halley/shared';
import type { Context, Hono } from 'hono';
import type { WebSocket } from 'ws';
import type { AuthService } from './auth/google.js';
import type { Clock, ControlPlaneDeps, IdGenerator } from './clock.js';
import type { HalleyConfig } from './config.js';
import type { ControlPlaneDb, SessionRecord } from './db.js';
import type { WorkspaceDriver } from './drivers/workspace-driver.js';
import type { WorkspaceHostDriver } from './drivers/workspace-host-driver.js';
import type { GitHubService } from './github/client.js';
import type { createPreviewProxy } from './proxy/preview-proxy.js';
import type { OptimizeService } from './routes/optimize.js';
import type { PublishService } from './routes/publish.js';
import type { RunnerClient } from './runner-client.js';
import type { ScreenshotService } from './screenshot-service.js';

export type Env = {
  Variables: {
    user: UserDto;
  };
};

export type App = Hono<Env>;

/** Pre-PR publish steps: the draft must not change under the checks, so the editor is locked. */
export const PUBLISH_LOCKED_STATES = new Set(['rebasing', 'resolving_conflicts', 'verifying', 'pushing_pr']);

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'edit'
  );
}

/** Inputs of an Undo draft's revert-start, persisted until it succeeds (editor_sessions.revert_pending_json). */
export interface PendingRevert {
  shas: string[];
  targetTitle: string;
  srcSessionId: string | null;
}

export type SessionEditCheck =
  | { error: string; status: 404 | 403 | 409; session?: undefined; user?: undefined }
  | { session: SessionRecord; user: UserDto; error?: undefined; status?: undefined };

export interface ControlPlaneContext {
  config: HalleyConfig;
  deps: ControlPlaneDeps;
  clock: Clock;
  randomUUID: IdGenerator;
  nowIso: () => string;
  /** Workspace-runner fetch through the injected transport (adds correlation headers). */
  runnerFetch: RunnerClient['runnerFetch'];
  db: ControlPlaneDb;
  auth: AuthService;
  github: GitHubService;
  /** The built-in supervisor driver, or null when a custom driver was injected. */
  hostDriver: WorkspaceHostDriver | null;
  driver: WorkspaceDriver;
  /** Open chat sockets per session (entries are removed with their last socket). */
  browserWsBySession: Map<string, Set<WebSocket>>;
  broadcastToSession: (sessionId: string, msg: ChatServerMessage) => void;
  enrichSessionDto: (
    s: SessionRecord,
    user: UserDto,
  ) => ReturnType<ControlPlaneDb['toSessionDto']> & { astroReady: boolean; bootProgress: BootProgressDto | null };
  convertAndBroadcastIfRevert: (sessionId: string) => ReturnType<ControlPlaneDb['convertRevertSession']>;
  publishService: PublishService;
  optimizeService: OptimizeService;
  screenshotService: ScreenshotService;
  /** Owner/admin check for routes that change a draft. */
  requireSessionEdit: (c: Context<Env>) => Promise<SessionEditCheck>;
}

/** Values one route module produces for another (wired explicitly by the composition root). */
export interface ControlPlaneExtras {
  previewProxy: ReturnType<typeof createPreviewProxy>;
  resumePendingRevert: (sessionId: string) => Promise<string | null>;
}
