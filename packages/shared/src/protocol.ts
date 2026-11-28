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
      touchLayout?: boolean;
    }
  | { type: 'halley:lock'; locked: boolean; reason?: string }
  | { type: 'halley:reload'; force?: boolean }
  /** Numbered markers for elements currently attached to the chat composer. */
  | { type: 'halley:pins'; pins: Array<{ key: string; n: number }> }
  /** Temporarily highlight an attached element (e.g. while hovering its chip). */
  | { type: 'halley:highlight'; key: string | null }
  /** Update the live progress text inside a newly created page placeholder. */
  | { type: 'halley:page-progress'; route: string; status: PageRequestStatus; message?: string };

// Preview Iframe -> Parent
export type PostMessageFromPreview =
  | { type: 'halley:ready'; route: string }
  /** Sent only when the user explicitly presses "Ask Halley…". `rect` is in iframe viewport coords. */
  | { type: 'halley:element-context'; context: ElementContext; rect?: PreviewRect }
  | { type: 'halley:patch-saved'; file: string; loc: string; summary: string }
  | { type: 'halley:route-changed'; route: string; fullPath: string; title: string }
  | { type: 'halley:edit-error'; message: string }
  /** Sent whenever an element selection opens or closes in the preview (used to hide mobile chat bubble). */
  | { type: 'halley:selection-changed'; active: boolean }
  /** Sent on pointerdown/touchstart inside the preview iframe so mobile floating chat card can dismiss cleanly. */
  | { type: 'halley:preview-pointerdown' };

export const SessionStatusSchema = z.enum([
  'starting',
  'running',
  'sleeping',
  'merged',
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
  crashLoop?: boolean;
  oom?: boolean;
  retryAfterSec?: number;
}

export const SessionKindSchema = z.enum(['edit', 'continuation', 'revert']);
export type SessionKind = z.infer<typeof SessionKindSchema>;

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
  'failed_deploy',
]);
export type PublishState = z.infer<typeof PublishStateSchema>;

export const CheckpointInfoSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  message: z.string(),
  summary: z.string(),
  timestamp: z.string(),
  author: z.string(),
  isSyncBoundary: z.boolean().optional(),
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

/** Internal protocol version negotiated between control-plane and workspaces supervisor. */
export const WORKSPACE_HOST_PROTOCOL_VERSION = 2;

export const PublishProgressPayloadSchema = z.object({
  state: PublishStateSchema,
  prNumber: z.number().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  deployUrl: z.string().nullable().optional(),
  liveSiteUrl: z.string().nullable().optional(),
  retryable: z.boolean().optional(),
  error: z.string().nullable().optional(),
  checks: z.array(VerificationCheckResultSchema).optional(),
  conflictedFiles: z.array(z.string()).optional(),
  ciLogs: z.string().nullable().optional(),
  queuePosition: z.number().nullable().optional(),
  queueMessage: z.string().nullable().optional(),
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
  /** True for assistant commentary emitted alongside tool calls (stopReason === 'toolUse'). */
  isIntermediate?: boolean;
  toolName?: string;
  toolArgsSummary?: string;
  toolStatus?: 'running' | 'done' | 'error';
  toolOutput?: string;
  contextChips?: ElementContext[];
  attachments?: StagedAttachment[];
  pageRequest?: PageRequestMetadata;
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
      type: 'preview_paused';
      paused: boolean;
      reason?: string;
    }
  | {
      type: 'page_request_state';
      pageRequest: PageRequestMetadata;
      autoNavigate?: boolean;
    }
  | {
      type: 'page_requests_sync';
      pageRequests: PageRequestMetadata[];
    }
  | {
      type: 'session_meta_updated';
    }
  | {
      type: 'session_state_sync';
      workspaceLocked: boolean;
      lockedFile?: string;
      previewPaused: boolean;
      previewPauseReason?: string;
      astroReady: boolean;
      publishProgress?: PublishProgressPayload | null;
      mergeReview?: MergeReviewStateDto | null;
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
  kind: SessionKind;
  parentSessionId: string | null;
  revertsSha: string | null;
  revertReason: string | null;
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
  prevBaseSha: string | null;
  status: SessionStatus;
  astroReady?: boolean;
  bootProgress?: BootProgressDto | null;
  publishState: PublishState;
  publishError: string | null;
  prNumber: number | null;
  prUrl: string | null;
  liveSiteUrl?: string | null;
  mergedSha: string | null;
  mergedAt: string | null;
  archivedAt: string | null;
  volumeExpired: boolean;
  astroBase: string;
  changedFilesCount: number;
  activeModelLabel?: string | null;
  lastActiveAt: string;
  createdAt: string;
}

export interface SessionArchiveDto {
  sessionId: string;
  transcriptJson: string;
  handoffSummary: string | null;
  diffSummary: string;
  mergedSha: string | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
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
    contextNotes?: string[];
  };
  usageUsd: number;
  usageByModel: Record<string, unknown>;
  live: LiveRunStateDto;
  entries: DebugTraceEntryDto[];
  recentLogs?: string[];
}

export interface RevertedCommitSummaryDto {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{
    path: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
  }>;
}
export type SpendPurpose = 'chat' | 'conflict' | 'conflict-escalation' | 'handoff' | 'optimize';

export type ConflictCategory =
  | 'adjacent_disjoint'
  | 'identical_intent'
  | 'formatting_vs_content'
  | 'refinement'
  | 'moved_refactored'
  | 'both_added'
  | 'derived_file'
  | 'delete_vs_modify'
  | 'true_contradiction'
  | 'binary_contradiction';

export type ConflictConfidence = 'high' | 'medium' | 'low';

export interface ConflictOptionDto {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
  previewText?: string;
  source: 'theirs' | 'ours' | 'combined' | 'custom';
}

export interface ConflictResolutionRecordDto {
  id: string;
  path: string;
  category: ConflictCategory;
  confidence: ConflictConfidence;
  status: 'auto_resolved' | 'needs_review' | 'needs_choice' | 'chosen';
  explanation: string;
  evidenceUsed: string[];
  affectedRoute?: string;
  options?: ConflictOptionDto[];
  chosenOptionId?: string;
  customInstruction?: string;
  oursPreview?: string;
  theirsPreview?: string;
  resolvedPreview?: string;
  resolvedContent?: string;
  modelUsed?: string;
}

export interface UpstreamCommitInfoDto {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  files?: string[];
  touchesProtected?: boolean;
}

export interface MergeReviewStateDto {
  mergeId: string;
  kind: 'sync' | 'publish' | 'revert';
  status: 'clean' | 'needs_choices' | 'ready_for_review' | 'applied' | 'aborted';
  preSyncSha: string;
  prevBaseSha: string;
  newBaseSha: string;
  alreadyUpToDate?: boolean;
  summary: string;
  records: ConflictResolutionRecordDto[];
  upstreamCommits: UpstreamCommitInfoDto[];
  touchedUserFiles: string[];
  firstPassUsageUsd?: number;
  advancedAttempt?: {
    records: ConflictResolutionRecordDto[];
    usageUsd: number;
    identicalToFirst: boolean;
    stoppedAtCeiling?: boolean;
    message?: string;
  };
}

export interface EscalationEstimateDto {
  estimatedInputTokens: number;
  aboutUsd: number;
  upToUsd: number;
  hardCeilingUsd: number;
  exceedsCeiling: boolean;
  remainingBudgetUsd: number;
  canAfford: boolean;
  modelLabel: string;
  conflictCount: number;
}

export interface ChangeCardDto {
  id: string;
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  title: string;
  route?: string;
  summary: string;
  attribution: string;
  conflictBadge?: 'auto_resolved' | 'needs_review' | 'chosen';
  overwriteWarning?: string;
  isImage?: boolean;
  beforePreview?: string;
  afterPreview?: string;
  wordDiff?: Array<{ type: 'equal' | 'add' | 'del'; value: string }>;
  jsonFields?: Array<{ field: string; before: string; after: string }>;
  diff: string;
  included: boolean;
}

export interface VisualDiffHighlightDto {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'draft' | 'merged_from_live';
  warning?: string;
  file?: string;
}

export interface VisualDiffHunkDto {
  id: string;
  liveScreenshotDataUrl?: string;
  draftScreenshotDataUrl: string;
  diffScreenshotDataUrl?: string;
  highlights: VisualDiffHighlightDto[];
  /** Cropped pixel dimensions (after any bottom height-alignment padding). */
  width: number;
  height: number;
  /** Original Y range in Draft full-page coordinates (px). */
  draftCropY: number;
  draftCropHeight: number;
  /** Original Y range in Live full-page coordinates (px), when Live was captured. */
  liveCropY?: number;
  liveCropHeight?: number;
  /** Horizontal crop box in full-page coordinates (px). */
  cropX: number;
  cropWidth: number;
  /** Unchanged vertical pixels trimmed immediately before this hunk. */
  unchangedBeforePx: number;
}

export interface VisualDiffViewportShotDto {
  liveScreenshotDataUrl?: string;
  draftScreenshotDataUrl?: string;
  diffScreenshotDataUrl?: string;
  highlights: VisualDiffHighlightDto[];
  width?: number;
  height?: number;
  /** Cropped diff hunks (1..4), or empty when identical === true. */
  hunks?: VisualDiffHunkDto[];
  /** Unchanged vertical pixels trimmed below the final hunk (or below 1400px Draft-only preview). */
  unchangedAfterPx?: number;
  /** True when Live and Draft rendered pixel-identically across the full page. */
  identical?: boolean;
  /** Full uncropped page dimensions (px) for context & "Full page" toggle. */
  fullWidth?: number;
  fullHeight?: number;
  hasFullPage?: boolean;
}

export interface VisualDiffPageDto {
  route: string;
  title: string;
  liveScreenshotDataUrl?: string;
  draftScreenshotDataUrl?: string;
  mobileLiveScreenshotDataUrl?: string;
  mobileDraftScreenshotDataUrl?: string;
  highlights: VisualDiffHighlightDto[];
  shots?: {
    desktop?: VisualDiffViewportShotDto;
    mobile?: VisualDiffViewportShotDto;
  };
  viewport?: 'desktop' | 'mobile';
  liveTimestamp: string;
}

export interface LiveHistoryEntryDto {
  id: string;
  source: 'halley' | 'github';
  sha: string;
  shortSha: string;
  title: string;
  authorName: string;
  timestamp: string;
  prNumber?: number | null;
  prUrl?: string | null;
  sessionId?: string | null;
  sessionKind?: SessionKind;
  parentSessionId?: string | null;
  revertsSha?: string | null;
  revertReason?: string | null;
  revertedBy?: { sessionId: string; authorName: string; timestamp: string; reason: string | null } | null;
  canUndo: boolean;
  undoDisabledReason?: string;
  volumeExpired?: boolean;
}

export const HALLEY_PLACEHOLDER_ATTR = 'data-halley-placeholder';

export const PageNavPlacementSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('group'), group: z.string().min(1) }),
]);
export type PageNavPlacement = z.infer<typeof PageNavPlacementSchema>;

export const PageRequestStatusSchema = z.enum([
  'created',
  'queued',
  'writing',
  'photo',
  'menu',
  'done',
  'failed',
  'capped',
]);
export type PageRequestStatus = z.infer<typeof PageRequestStatusSchema>;

export const CreatePageRequestSchema = z.object({
  title: z.string().trim().min(1, 'Page title is required').max(160),
  slug: z.string().trim().min(1, 'URL slug is required').max(160),
  section: z.string().trim().default('/'),
  purpose: z.string().max(4000).optional(),
  styleLikeRoute: z.string().optional(),
  nav: PageNavPlacementSchema.default({ mode: 'none' }),
  unlisted: z.boolean().default(false),
  attachment: StagedAttachmentSchema.optional(),
  editorContext: EditorContextSchema.optional(),
});
export type CreatePageRequest = z.infer<typeof CreatePageRequestSchema>;

export const PageRequestMetadataSchema = z.object({
  pageRequestId: z.string(),
  title: z.string(),
  route: z.string(),
  file: z.string(),
  section: z.string(),
  purpose: z.string().optional(),
  styleLikeRoute: z.string().optional(),
  nav: PageNavPlacementSchema,
  unlisted: z.boolean(),
  attachment: StagedAttachmentSchema.optional(),
  status: PageRequestStatusSchema,
  error: z.string().optional(),
  instructions: z.string().optional(),
  createdAt: z.number().optional(),
});
export type PageRequestMetadata = z.infer<typeof PageRequestMetadataSchema>;

export interface SiteRouteEntryDto {
  route: string;
  label: string;
  file?: string;
  section?: string;
  unlisted?: boolean;
  mtimeMs?: number;
}

export interface PageSectionOptionDto {
  section: string;
  label: string;
  defaultStyleRoute?: string;
}

export interface PageCreationOptionsDto {
  sections: PageSectionOptionDto[];
  routes: SiteRouteEntryDto[];
  dynamicPatterns: string[];
  generatedRoutes: string[];
  navGroups: string[];
  capped: boolean;
}

export interface CreatePageResultDto {
  ok: true;
  route: string;
  file: string;
  pageRequest: PageRequestMetadata;
  checkpoint?: CheckpointInfo | null;
  changedFilesCount?: number;
}

/**
 * Normalizes a single URL segment: strips diacritics/accents, lowercases,
 * replaces non-alphanumeric runs with hyphens, and trims leading/trailing hyphens.
 */
export function slugifyRouteSegment(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Normalizes a slug that may contain slash-separated segments (e.g. "retreats/spring-2026").
 */
export function slugifyPagePath(raw: string): string {
  return raw
    .split('/')
    .map((seg) => slugifyRouteSegment(seg))
    .filter(Boolean)
    .join('/');
}

const RESERVED_EXACT_ROUTES = new Set([
  '/',
  '/404',
  '/500',
  '/index',
  '/robots.txt',
  '/sitemap.xml',
  '/sitemap-index.xml',
  '/favicon.ico',
]);

const RESERVED_PREFIXES = ['/api', '/p', '/assets', '/images', '/_astro', '/__editor', '/ws', '/internal'];

function normalizeRoute(route: string): string {
  const trimmed = route.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function matchesDynamicPattern(route: string, pattern: string): boolean {
  const rSegs = normalizeRoute(route).split('/').filter(Boolean);
  const pSegs = normalizeRoute(pattern).split('/').filter(Boolean);
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i]!;
    if (p.startsWith('[...') && p.endsWith(']')) {
      return rSegs.length >= i;
    }
    if (i >= rSegs.length) return false;
    if (p.startsWith('[') && p.endsWith(']')) continue;
    if (p.toLowerCase() !== rSegs[i]!.toLowerCase()) return false;
  }
  return rSegs.length === pSegs.length;
}

export interface ValidateNewPageRouteInput {
  section: string;
  slug: string;
  existingRoutes: string[];
  dynamicPatterns?: string[];
  generatedRoutes?: string[];
}

export interface ValidateNewPageRouteResult {
  valid: boolean;
  route: string;
  normalizedSlug: string;
  error?: string;
  collisionRoute?: string;
}

export function validateNewPageRoute(input: ValidateNewPageRouteInput): ValidateNewPageRouteResult {
  const cleanSection = normalizeRoute(input.section || '/');
  const cleanSlug = slugifyPagePath(input.slug || '');

  if (!cleanSlug) {
    return {
      valid: false,
      route: cleanSection === '/' ? '/' : `${cleanSection}/`,
      normalizedSlug: '',
      error: 'Enter a URL slug using letters or numbers.',
    };
  }

  const route = cleanSection === '/' ? `/${cleanSlug}` : `${cleanSection}/${cleanSlug}`;
  const lowerRoute = route.toLowerCase();

  if (RESERVED_EXACT_ROUTES.has(lowerRoute)) {
    return {
      valid: false,
      route,
      normalizedSlug: cleanSlug,
      error: `\`${route}\` is a reserved site path.`,
    };
  }

  for (const prefix of RESERVED_PREFIXES) {
    if (lowerRoute === prefix || lowerRoute.startsWith(`${prefix}/`)) {
      return {
        valid: false,
        route,
        normalizedSlug: cleanSlug,
        error: `Paths under \`${prefix}\` are reserved.`,
      };
    }
  }

  for (const existing of input.existingRoutes) {
    const norm = normalizeRoute(existing);
    if (norm.toLowerCase() === lowerRoute) {
      return {
        valid: false,
        route,
        normalizedSlug: cleanSlug,
        error: `A page already exists at ${norm}.`,
        collisionRoute: norm,
      };
    }
  }

  for (const gen of input.generatedRoutes ?? []) {
    const norm = normalizeRoute(gen);
    if (norm.toLowerCase() === lowerRoute) {
      return {
        valid: false,
        route,
        normalizedSlug: cleanSlug,
        error: `This URL is already used by a generated page (${norm}).`,
        collisionRoute: norm,
      };
    }
  }

  for (const pattern of input.dynamicPatterns ?? []) {
    if (matchesDynamicPattern(route, pattern)) {
      return {
        valid: false,
        route,
        normalizedSlug: cleanSlug,
        error: `This URL conflicts with dynamic route \`${pattern}\`.`,
      };
    }
  }

  return {
    valid: true,
    route,
    normalizedSlug: cleanSlug,
  };
}

// ============================================================================
// Optimize Astro — Halley Readiness & Speed Advisor DTOs
// ============================================================================

export type OptimizationPillar =
  | 'inline_edit'
  | 'agent_context'
  | 'source_mapping'
  | 'guardrails'
  | 'speed_and_ci';

export type OptimizationActionKind =
  | 'deterministic_webp'
  | 'deterministic_gitignore'
  | 'agent_refactor'
  | 'workflow_yaml';

export interface OptimizationFindingDto {
  id: string;
  pillar: OptimizationPillar;
  severity: 'high' | 'medium' | 'low';
  actionKind: OptimizationActionKind;
  source: 'static' | 'ai';
  title: string;
  description: string;
  impactLabel: string;
  files: Array<{ path: string; line?: number; detail?: string }>;
  scorePenalty: number;
  workflowSuggestion?: {
    targetPath: string;
    githubEditUrl: string;
    yamlContent: string;
  };
  webpCandidate?: {
    publicRelPath: string;
    bytes: number;
  };
  agentInstructions?: string;
}

export interface AstroAuditMetricsDto {
  totalTextElements: number;
  inlineEditableElements: number;
  inlineEditablePct: number;
  intentionalDynamicElements: number;
  avoidableLockedElements: number;
  astroPageCount: number;
  oversizedImageBytes: number;
}

export interface AstroAuditReportDto {
  id: string;
  sha: string;
  shortSha: string;
  baseBranch: string;
  score: number;
  pillarScores: Record<OptimizationPillar, number>;
  metrics: AstroAuditMetricsDto;
  findings: OptimizationFindingDto[];
  aiReviewedAt: string | null;
  aiSummary: string | null;
  aiCostUsd: number;
  createdAt: string;
  previousReport?: {
    sha: string;
    shortSha: string;
    score: number;
    inlineEditablePct: number;
    createdAt: string;
  } | null;
}

export interface OptimizeAiEstimateDto {
  sha: string;
  modelId: string;
  inputTokens: number;
  estimatedUsd: number;
  ceilingUsd: number;
  remainingBudgetUsd: number;
  alreadyReviewed: boolean;
}

// ============================================================================
// API Boundary Request Schemas (Zod-validated in Control-Plane & Runner)
// ============================================================================

export const CreateSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const UpdateSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const PublishRequestSchema = z.object({
  title: z.string().trim().max(240).optional(),
  summary: z.string().trim().max(4000).optional(),
  excludePaths: z.array(z.string().min(1).max(500)).max(200).optional(),
  background: z.boolean().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const SyncStartRequestSchema = z.object({
  kind: z.enum(['sync', 'publish', 'revert']).optional(),
  autoSyncOnly: z.boolean().optional(),
  autoApplyCleanOnly: z.boolean().optional(),
  skipFetch: z.boolean().optional(),
});
export type SyncStartRequest = z.infer<typeof SyncStartRequestSchema>;

export const RevertSessionCreateSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(120).optional(),
    sha: z.string().trim().min(4).max(80).optional(),
    shas: z.array(z.string().trim().min(4).max(80)).max(50).optional(),
    reason: z.string().trim().max(1000).optional(),
    title: z.string().trim().max(240).optional(),
  })
  .refine((v) => Boolean(v.sessionId || v.sha || (v.shas && v.shas.length > 0)), {
    message: 'Commit SHA or sessionId is required',
  });

export const AdminAllowlistCreateSchema = z.object({
  kind: z.enum(['email', 'domain']),
  value: z.string().trim().min(2).max(320),
});

export const AdminSpendCapSchema = z.object({
  dailyCapUsd: z.number().finite().nonnegative().max(10_000),
});

export const AdminGrantExtraSchema = z.object({
  userId: z.string().trim().min(1).optional(),
  extraUsd: z.number().finite().positive().max(10_000).optional(),
});
