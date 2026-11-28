import type { BootProgressDto, BootStage } from '@halley/shared';
import type { FifoBuildQueue } from '../build-queue.js';
import type { AsyncMutex, KeyedMutex } from '../mutex.js';
import type { NodeModulesCacheManager } from '../nm-cache.js';
import type { Clock, TimerHandle } from '../clock.js';
import type {
  StartPhaseTimings,
  SupervisorOptions,
  ManagedSession,
  CrashedSessionInfo,
  WarmSlot,
} from './shared.js';

/**
 * Explicit view of createWorkspaceSupervisor's state shared by its parts (src/supervisor/*).
 * Mutable fields are accessors onto the supervisor's variables: reads are always current.
 */
export interface SupervisorContext {
  readonly opts: SupervisorOptions;
  readonly clock: Clock;
  readonly instanceId: `${string}-${string}-${string}-${string}-${string}`;
  readonly sessionsRoot: string;
  readonly mirrorDir: string;
  readonly nmCacheDir: string;
  readonly pkgCacheDir: string;
  readonly verifySandboxDir: string;
  readonly nmCache: NodeModulesCacheManager;
  readonly buildQueueTimeoutMs: number;
  readonly buildQueue: FifoBuildQueue;
  readonly runnerHeapMb: number;
  readonly runnerStopGraceMs: number;
  readonly crashedSessions: CrashedSessionInfo[];
  activeHostSecret: string;
  readonly allocateLeasedPort: (host?: string) => Promise<number>;
  readonly releaseLeasedPort: (port: number) => void;
  readonly activeSessions: Map<string, ManagedSession>;
  readonly bootingSessions: Map<string, Promise<ManagedSession>>;
  readonly deletedSessionIds: Map<string, number>;
  readonly logsBySession: Map<string, string[]>;
  readonly bootProgressBySession: Map<string, BootProgressDto>;
  readonly startPhasesBySession: Map<string, StartPhaseTimings>;
  readonly admissionMutex: AsyncMutex;
  readonly admittedBooting: Set<string>;
  readonly sessionGitLocks: KeyedMutex;
  readonly assertDiskAdmission: (operation: string, fields?: Record<string, unknown>) => Promise<void>;
  readonly markDeleted: (sessionId: string) => void;
  readonly pruneTombstones: () => void;
  readonly pruneLogBuffers: () => void;
  warmPool: WarmSlot[];
  readonly reservedWarmSlots: Map<string, WarmSlot>;
  warmPoolRunning: boolean;
  warmHealthTimer: TimerHandle | null;
  supervisorSelfUrl: string;
  readonly runnerEntry: string;
  readonly controlPlaneBase: string;
  readonly internalGitUrl: string;
  readonly sessionDir: (sessionId: string) => string;
  readonly appendLog: (sessionId: string, chunk: Buffer | string, isErr: boolean) => void;
  readonly emitProgress: (sessionId: string, stage: BootStage, message: string, extra?: { detail?: string; warmHit?: boolean; startedAt?: string; }) => BootProgressDto;
  readonly runGit: (cwd: string, args: string[], includeAuthHeader?: boolean, timeoutMs?: number) => Promise<string>;
  readonly withMirrorRead: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly syncLocalMirror: (baseBranch: string) => Promise<string>;
  readonly runMirrorMaintenance: () => Promise<'ran' | 'skipped'>;
  readonly discardSlot: (id: string, context: string) => Promise<void>;
  readonly recycleStaleWarmSlots: (latestBaseSha: string) => Promise<void>;
  readonly stopSessionProcess: (sessionId: string) => Promise<void>;
  readonly admitSession: (sessionId: string, protectedIds: Set<string>) => Promise<void>;
  readonly spawnRunnerForSession: (params: { sessionId: string; workspaceDir: string; stateDir: string; baseBranch: string; baseSha: string; workspaceToken: string; persona: 'non-technical' | 'developer'; editorName: string; editorEmail: string; readOnly: boolean; isWarmStandby: boolean; phasesMs?: Record<string, number>; }) => Promise<ManagedSession>;
  readonly replenishWarmPool: () => void;
}
