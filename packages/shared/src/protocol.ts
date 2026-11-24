import { z } from 'zod';

// Browse = the real site (links work). Edit = clicks select elements; editable
// static text gets an inline caret, and anything can be explicitly sent to chat.
export const PreviewModeSchema = z.enum(['browse', 'edit']);
export type PreviewMode = z.infer<typeof PreviewModeSchema>;

export const ElementContextSchema = z.object({
  file: z.string(),
  loc: z.string(),
  route: z.string(),
  tagName: z.string(),
  renderedText: z.string(),
  outerHTML: z.string(),
  reason: z.enum(['dynamic', 'selected']),
  /** Exact phrase the user highlighted inside the element, if any. */
  selectedText: z.string().optional(),
});
export type ElementContext = z.infer<typeof ElementContextSchema>;

/** Stable identity of a source-mapped element inside the preview. */
export const elementKey = (c: { file: string; loc: string }) => `${c.file}:${c.loc}`;

/** Plain-English element kind for non-technical maintainers (no raw HTML tags). */
export function friendlyElementKind(tagName: string): string {
  const t = tagName.toLowerCase();
  if (/^h[1-6]$/.test(t)) return 'Heading';
  if (t === 'p' || t === 'span' || t === 'strong' || t === 'em' || t === 'small') return 'Text';
  if (t === 'blockquote') return 'Quote';
  if (t === 'a') return 'Link';
  if (t === 'button') return 'Button';
  if (t === 'img' || t === 'picture' || t === 'svg') return 'Image';
  if (t === 'figure' || t === 'figcaption') return 'Caption';
  if (t === 'ul' || t === 'ol') return 'List';
  if (t === 'li') return 'List item';
  if (t === 'nav') return 'Navigation';
  if (t === 'header') return 'Header';
  if (t === 'footer') return 'Footer';
  if (t === 'table' || t === 'tr' || t === 'td' || t === 'th') return 'Table';
  if (t === 'form' || t === 'input' || t === 'textarea' || t === 'select') return 'Form';
  return 'Section';
}

export interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Parent -> Preview Iframe
export type PostMessageToPreview =
  | {
      type: 'halley:set-mode';
      mode: PreviewMode;
      readOnly: boolean;
      persona?: 'non-technical' | 'developer';
    }
  | { type: 'halley:lock'; locked: boolean; reason?: string }
  | { type: 'halley:reload'; force?: boolean }
  /** Numbered markers for elements currently attached to the chat composer. */
  | { type: 'halley:pins'; pins: Array<{ key: string; n: number }> }
  /** Temporarily highlight an attached element (e.g. while hovering its chip). */
  | { type: 'halley:highlight'; key: string | null };

// Preview Iframe -> Parent
export type PostMessageFromPreview =
  | { type: 'halley:ready'; route: string }
  /** Sent only when the user explicitly presses "Ask Halley…". `rect` is in iframe viewport coords. */
  | { type: 'halley:element-context'; context: ElementContext; rect?: PreviewRect }
  | { type: 'halley:patch-saved'; file: string; loc: string; summary: string }
  | { type: 'halley:route-changed'; route: string; fullPath: string; title: string }
  | { type: 'halley:edit-error'; message: string };

export const SessionStatusSchema = z.enum([
  'starting',
  'running',
  'sleeping',
  'published',
  'error',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const BootStageSchema = z.enum([
  'queued',
  'claiming_warm',
  'syncing_repo',
  'checking_image',
  'pulling_image',
  'creating_container',
  'starting_container',
  'cloning_repo',
  'installing_deps',
  'starting_preview',
  'starting_ai',
  'ready',
  'error',
]);
export type BootStage = z.infer<typeof BootStageSchema>;

export interface BootProgressDto {
  stage: BootStage;
  message: string;
  detail?: string;
  startedAt: string;
  updatedAt: string;
  warmHit?: boolean;
}

export const PublishStateSchema = z.enum([
  'idle',
  'verifying',
  'rebasing',
  'resolving_conflicts',
  'pushing_pr',
  'waiting_ci',
  'deploying_pages',
  'published',
  'failed_checks',
  'failed_conflict',
  'failed_ci',
]);
export type PublishState = z.infer<typeof PublishStateSchema>;

export const CheckpointInfoSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  message: z.string(),
  summary: z.string(),
  timestamp: z.string(),
  author: z.string(),
});
export type CheckpointInfo = z.infer<typeof CheckpointInfoSchema>;

export const GitFileChangeSchema = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked']),
  additions: z.number(),
  deletions: z.number(),
  diff: z.string(),
});
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

export const VerificationCheckResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  passed: z.boolean(),
  durationMs: z.number(),
  output: z.string(),
});
export type VerificationCheckResult = z.infer<typeof VerificationCheckResultSchema>;

export const PublishProgressPayloadSchema = z.object({
  state: PublishStateSchema,
  prNumber: z.number().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  deployUrl: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  checks: z.array(VerificationCheckResultSchema).optional(),
  conflictedFiles: z.array(z.string()).optional(),
  ciLogs: z.string().nullable().optional(),
});
export type PublishProgressPayload = z.infer<typeof PublishProgressPayloadSchema>;

export const StagedAttachmentSchema = z.object({
  stagedId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  thumbnailDataUrl: z.string().optional(),
});
export type StagedAttachment = z.infer<typeof StagedAttachmentSchema>;

export const EditorContextSchema = z.object({
  currentRoute: z.string(),
  viewport: z.enum(['desktop', 'tablet', 'mobile']).optional(),
  mode: PreviewModeSchema.optional(),
});
export type EditorContext = z.infer<typeof EditorContextSchema>;

export const ChatClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('submit_input'),
    requestId: z.string(),
    text: z.string(),
    contextChips: z.array(ElementContextSchema).default([]),
    attachments: z.array(StagedAttachmentSchema).default([]),
    editorContext: EditorContextSchema.optional(),
    whenBusy: z.enum(['steer', 'followUp']).optional(),
  }),
  z.object({
    type: z.literal('abort'),
  }),
  z.object({
    type: z.literal('continue_run'),
  }),
]);
export type ChatClientMessage = z.infer<typeof ChatClientMessageSchema>;

export interface TranscriptEntryDto {
  id: string;
  kind: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'activity';
  text: string;
  toolName?: string;
  toolArgsSummary?: string;
  toolStatus?: 'running' | 'done' | 'error';
  toolOutput?: string;
  contextChips?: ElementContext[];
  attachments?: StagedAttachment[];
  createdAt?: number;
}

export interface LiveRunStateDto {
  busy: boolean;
  streamingText?: string;
  activeTools: Array<{
    callId: string;
    name: string;
    summary: string;
    output?: string;
    status: 'running' | 'sleeping' | 'waiting' | 'done' | 'error';
  }>;
  queuedCount: number;
  runFailure?: {
    reason: string;
    detail?: string;
  };
}

export type ChatServerMessage =
  | {
      type: 'transcript_state';
      entries: TranscriptEntryDto[];
      live: LiveRunStateDto;
      usageUsd: number;
    }
  | {
      type: 'workspace_lock';
      locked: boolean;
      file?: string;
    }
  | {
      type: 'checkpoint_created';
      checkpoint: CheckpointInfo;
      changedFilesCount: number;
    }
  | {
      type: 'publish_state';
      payload: PublishProgressPayload;
    }
  | {
      type: 'spend_status';
      spentTodayUsd: number;
      dailyCapUsd: number;
      extraGrantedUsd: number;
      capped: boolean;
    }
  | {
      type: 'boot_progress';
      progress: BootProgressDto;
    }
  | {
      type: 'error';
      message: string;
    };

export const HalleyRepoConfigSchema = z.object({
  checks: z
    .array(
      z.object({
        name: z.string(),
        command: z.string(),
      }),
    )
    .optional(),
  imageDirHint: z.string().optional(),
  hygiene: z
    .object({
      forbidRootRelativeLinks: z.boolean().optional(),
      verifyPublicAssets: z.boolean().optional(),
    })
    .optional(),
});
export type HalleyRepoConfig = z.infer<typeof HalleyRepoConfigSchema>;

export const AgentPersonaSchema = z.enum(['non-technical', 'developer']);
export type AgentPersona = z.infer<typeof AgentPersonaSchema>;

export interface UserDto {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  isAdmin: boolean;
  persona: AgentPersona;
}

export interface EditorSessionDto {
  id: string;
  title: string;
  slug: string;
  ownerUserId: string;
  ownerName: string;
  ownerEmail: string;
  ownerPicture: string | null;
  isOwner: boolean;
  canEdit: boolean;
  repo: string;
  baseBranch: string;
  workingBranch: string;
  baseSha: string;
  status: SessionStatus;
  bootProgress?: BootProgressDto | null;
  publishState: PublishState;
  publishError: string | null;
  prNumber: number | null;
  prUrl: string | null;
  astroBase: string;
  changedFilesCount: number;
  lastActiveAt: string;
  createdAt: string;
}

export interface SpendStatusDto {
  spentTodayUsd: number;
  dailyCapUsd: number;
  extraGrantedUsd: number;
  capped: boolean;
}

export interface AllowlistEntryDto {
  id: string;
  kind: 'email' | 'domain';
  value: string;
  addedBy: string | null;
  createdAt: string;
}

export interface DebugTraceEntryDto {
  id: string;
  kind: string;
  role: 'user' | 'assistant' | 'tool' | 'other';
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
  toolCallId?: string;
  toolName?: string;
  toolOutput?: string;
  isError?: boolean;
  imagesCount?: number;
  model?: string;
  stopReason?: string;
  usage?: unknown;
}

export interface DebugTraceDto {
  exportedAt: string;
  sessionId: string;
  modelId: string;
  thinkingLevel: string;
  persona: string;
  previewBase: string;
  lastEditorContext?: EditorContext | null;
  systemPrompt: {
    halleyRole: string;
    agentsMd: string | null;
  };
  usageUsd: number;
  usageByModel: Record<string, unknown>;
  live: LiveRunStateDto;
  entries: DebugTraceEntryDto[];
}

