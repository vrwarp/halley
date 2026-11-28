import type { EditUndoStack, PerFileMutex } from '@halley/astro-dev-edit';
import type {
  ChatServerMessage,
  GitFileChange,
  MergeReviewStateDto,
  SiteRouteEntryDto,
} from '@halley/shared';
import type { WebSocket } from 'ws';
import type { GitIdentity } from './checkpoints-and-git.js';
import type { Clock, TimerHandle } from './clock.js';
import type { ConflictEvidencePack } from './conflict-protocol.js';
import type { AstroManagerLike, PiRuntimeLike, RunnerConfig, ThinkingLevel, WsClientState } from './index.js';
import type { NodeModulesCacheManager } from './nm-cache.js';
import type { PageCreationService } from './pages.js';
import type { UploadManager } from './uploads.js';

/**
 * Explicit view of createRunner's state that the route modules (src/routes/*) are registered with.
 * Mutable fields are accessors onto createRunner's variables: reads are always current, writes
 * update the runner.
 */
export interface RunnerContext {
  readonly config: RunnerConfig;
  readonly randomUUID: () => string;
  readonly REPO_ROOT: string;
  readonly STATE_DIR: string;
  readonly SESSION_ID: string;
  readonly BASE_BRANCH: string;
  baseSha: string;
  readonly CONTROL_PLANE_INTERNAL_URL: string;
  readonly SUPERVISOR_URL: string;
  activeHostSecret: string;
  workspaceToken: string;
  readonly MODEL_ID: string;
  readonly THINKING_LEVEL: ThinkingLevel;
  persona: 'non-technical' | 'developer';
  readOnly: boolean;
  prevBaseSha: string;
  readonly gitIdentity: GitIdentity;
  readonly savePersistedSessionMeta: () => Promise<void>;
  readonly saveMetaLogged: (context: string) => Promise<void>;
  readonly changesOrEmpty: (baseRef?: string) => Promise<GitFileChange[]>;
  readonly resolveHeadSha: () => Promise<string | null>;
  readonly syncPageRequestsLogged: (context: string) => Promise<boolean | undefined>;
  readonly fileLock: PerFileMutex;
  readonly editUndoStack: EditUndoStack;
  readonly uploadManager: UploadManager;
  latestTranscript: Extract<ChatServerMessage, { type: 'transcript_state' }> | null;
  currentPreviewPaused: boolean;
  currentPreviewPauseReason: string | undefined;
  readonly broadcast: (msg: ChatServerMessage) => void;
  readonly reportCheckpointFailure: (context: string, err: unknown) => void;
  readonly notifySessionDiverged: (changedFilesCount?: number) => void;
  readonly notifyOptimizationSettled: () => Promise<void>;
  readonly cancelSpeculativeVerify: () => void;
  readonly triggerImmediateSpeculativeVerify: () => void;
  readonly scheduleIdleSpeculativeVerify: (delayMs?: number) => void;
  activeVerifyRuns: number;
  readonly cancelInlineEditTimer: () => void;
  readonly scheduleInlineCheckpoint: (summary: string) => void;
  readonly astroManager: AstroManagerLike;
  piRuntime: PiRuntimeLike | null;
  originalBase: string;
  previewBase: string;
  readonly pageService: PageCreationService;
  activeMergeState: MergeReviewStateDto | null;
  activeConflictPacks: Map<string, ConflictEvidencePack>;
  activeVirtualTreeSha: string | undefined;
  activeMergeNeedsLlmPass: boolean;
  activeSyncOps: number;
  readonly persistMergeReviewState: () => Promise<void>;
  readonly runnerNmCache: NodeModulesCacheManager;
  readonly loadRoutesDedup: () => Promise<SiteRouteEntryDto[]>;
  readonly clock: Clock;
  readonly wsClients: Map<WebSocket, WsClientState>;
  readonly wsEpoch: string;
  readonly safeSend: (ws: WebSocket, payload: string) => void;
  lastTranscriptPayload: string;
  currentWorkspaceLocked: boolean;
  currentLockedFile: string | undefined;
  draining: boolean;
  shuttingDown: boolean;
  wsHeartbeatTimer: TimerHandle | null;
  readonly ready: Promise<void>;
}
