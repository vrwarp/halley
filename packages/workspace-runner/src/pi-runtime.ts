import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  section,
  ToolResultEntry,
  ToolTask,
  UserEntry,
  wrapTool,
  type Conversation,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createFitImagesExtension, fitImage } from '@earendil-works/pi-durable/images/fit';
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  createCodingTools,
  createEditTool,
  createWriteTool,
  imageLimits,
} from '@earendil-works/pi-durable/tools';
import { num, obj, oneOf, opt, str } from '@earendil-works/pi-schema';
import type { AsyncFileLock } from '@halley/astro-dev-edit';
import type {
  ElementContext,
  LiveRunStateDto,
  StagedAttachment,
  TranscriptEntryDto,
} from '@halley/shared';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { runAllVerificationChecks } from './verify.js';
import type { UploadManager } from './uploads.js';

export interface PiRuntimeOptions {
  repoRoot: string;
  stateDir: string;
  sessionId: string;
  previewBase: string;
  astroPort: number;
  controlPlaneInternalUrl: string;
  workspaceToken: string;
  modelId: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  getPersona?: () => 'non-technical' | 'developer';
  fileLock: AsyncFileLock;
  uploadManager: UploadManager;
  onLockChange: (locked: boolean, file?: string) => void;
  onRunFinishedWithEdits: (summary: string) => Promise<void>;
  onTranscriptUpdate: (snapshot: {
    entries: TranscriptEntryDto[];
    live: LiveRunStateDto;
    usageUsd: number;
  }) => void;
}

function isProtectedPath(repoRoot: string, targetPath: string): boolean {
  const abs = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(repoRoot, targetPath);
  const rel = path.relative(path.resolve(repoRoot), abs).split(path.sep).join('/');
  return rel === '.github' || rel.startsWith('.github/') || rel.startsWith('..');
}

function resolveAnthropicModelId(
  requestedId: string,
  models: ReadonlyArray<{ id: string }>,
): string {
  const family =
    requestedId === 'sonnet-latest'
      ? 'sonnet'
      : requestedId === 'opus-latest'
        ? 'opus'
        : requestedId === 'haiku-latest'
          ? 'haiku'
          : null;
  if (!family) return requestedId;

  const parseVersion = (id: string): number[] => {
    const clean = id.replace(/-\d{8}$/, '');
    const nums = clean.match(/\d+/g)?.map(Number) ?? [0];
    // Prefer undated alias over dated snapshot when version numbers tie
    const isUndated = clean === id ? 1 : 0;
    return [...nums, isUndated];
  };

  const candidates = models
    .filter((m) => m.id.includes(family))
    .sort((a, b) => {
      const va = parseVersion(a.id);
      const vb = parseVersion(b.id);
      const len = Math.max(va.length, vb.length);
      for (let i = 0; i < len; i++) {
        const diff = (vb[i] ?? 0) - (va[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

  return candidates[0]?.id ?? requestedId;
}

export class HalleyPiRuntime {
  private harness!: Harness;
  private root!: Conversation;
  private watchHandle: Awaited<ReturnType<Conversation['watch']>> | null = null;
  private images!: Awaited<ReturnType<typeof createNodePhotonImages>>;
  private models = createModels();
  private resolvedModelId = '';

  constructor(private opts: PiRuntimeOptions) {}

  async start(): Promise<void> {
    await fs.mkdir(this.opts.stateDir, { recursive: true });
    const sqlitePath = path.join(this.opts.stateDir, 'pi.sqlite');

    // Route Anthropic requests through the Control Plane LLM proxy using WORKSPACE_TOKEN.
    // Raw ANTHROPIC_API_KEY never enters the workspace container.
    const baseAnthropic = anthropicProvider();
    const proxyBaseUrl = `${this.opts.controlPlaneInternalUrl.replace(/\/$/, '')}/internal/llm/anthropic`;
    const proxiedModels = baseAnthropic.getModels().map((m) => ({
      ...m,
      baseUrl: proxyBaseUrl,
    }));
    this.resolvedModelId = resolveAnthropicModelId(this.opts.modelId, proxiedModels);
    console.log(
      `[halley-pi] model=${this.opts.modelId} -> ${this.resolvedModelId} (thinking=${this.opts.thinkingLevel})`,
    );
    const proxiedAnthropic = {
      ...baseAnthropic,
      name: 'Anthropic (Halley Proxy)',
      baseUrl: proxyBaseUrl,
      getModels: () => proxiedModels,
      auth: {
        apiKey: {
          name: 'Halley Workspace Token',
          login: async () => ({ type: 'api_key' as const, key: this.opts.workspaceToken }),
          resolve: async () => ({
            auth: {
              headers: {
                Authorization: `Bearer ${this.opts.workspaceToken}`,
              },
            },
            source: 'Halley WORKSPACE_TOKEN',
          }),
        },
      },
    };
    this.models.setProvider(proxiedAnthropic);

    this.images = await createNodePhotonImages();
    const registry = createRegistry();
    registry.install(createCodingTools({ images: this.images }));
    registry.install(createFitImagesExtension(this.images));

    const agentsMdText = await fs
      .readFile(path.join(this.opts.repoRoot, 'AGENTS.md'), 'utf8')
      .catch(() => '');

    const halleyExtension = this.buildHalleyExtension(agentsMdText);
    registry.install(halleyExtension);

    const storage = await openNodeSqliteStorage(sqlitePath);
    this.harness = await Harness.open(
      storage,
      {
        models: this.models,
        registry,
        env: () =>
          new NodeExecutionEnv({
            cwd: this.opts.repoRoot,
          }),
        settings: {
          progress: {
            partialIntervalMs: 120,
            outputIntervalMs: 150,
            persistWithinMs: 1000,
          },
          retry: { maxRetries: 2 },
        },
      },
      BACKGROUND_CONTEXT,
    );

    this.root = await this.harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'anthropic', modelId: this.resolvedModelId },
        thinkingLevel: this.opts.thinkingLevel,
        cwd: this.opts.repoRoot,
      },
    });

    this.watchHandle = await this.root.watch(BACKGROUND_CONTEXT);
    this.opts.onTranscriptUpdate(this.mapWatchValue(this.watchHandle.value));
    this.watchHandle.start(async (call) => {
      if (call.kind === 'value') {
        this.opts.onTranscriptUpdate(this.mapWatchValue(call.value));
      }
    });

    this.harness.resume();
  }

  private buildHalleyExtension(agentsMdText: string) {
    const opts = this.opts;

    const processImageTool = defineTool({
      name: 'process_image',
      description:
        'Convert a staged user-uploaded image into an optimized WebP image inside the repository (strips EXIF/GPS metadata, auto-orients, and resizes). Use this whenever placing an uploaded photo into public/images/...',
      parameters: obj({
        stagedId: str({ description: 'The stagedId from the attached upload metadata' }),
        destPath: str({
          description:
            'Repository-relative destination path ending in .webp (e.g. public/images/community/youth-retreat.webp)',
        }),
        maxWidth: opt(num({ description: 'Maximum width in pixels (default 2400)' })),
        quality: opt(num({ description: 'WebP quality 1-100 (default 84)' })),
      }),
      execute: async (args) => {
        if (isProtectedPath(opts.repoRoot, args.destPath)) {
          return { output: [{ type: 'text', text: 'Cannot write to protected path.' }], isError: true };
        }
        const staged = await opts.uploadManager.resolveStagedFile(args.stagedId);
        if (!staged) {
          return {
            output: [{ type: 'text', text: `Staged upload not found: ${args.stagedId}` }],
            isError: true,
          };
        }
        const destAbs = path.resolve(opts.repoRoot, args.destPath);
        if (!destAbs.startsWith(path.resolve(opts.repoRoot) + path.sep)) {
          return { output: [{ type: 'text', text: 'Invalid destination path.' }], isError: true };
        }

        await opts.fileLock.withLock(args.destPath, async () => {
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          const maxWidth = args.maxWidth ?? 2400;
          const quality = args.quality ?? 84;
          // .rotate() auto-orients from EXIF; omitting .withMetadata() strips all EXIF/GPS
          const webpBuf = await sharp(staged.bytes)
            .rotate()
            .resize({ width: maxWidth, withoutEnlargement: true })
            .webp({ quality })
            .toBuffer();
          const tmp = `${destAbs}.tmp-${Date.now()}`;
          await fs.writeFile(tmp, webpBuf);
          await fs.rename(tmp, destAbs);
        });

        const meta = await sharp(destAbs).metadata();
        return {
          output: [
            {
              type: 'text',
              text: `Saved optimized WebP (${meta.width}x${meta.height}, EXIF stripped) to ${args.destPath}`,
            },
          ],
        };
      },
    });

    const screenshotPageTool = defineTool({
      name: 'screenshot_page',
      description:
        'Capture a live browser screenshot of a route on the running astro dev preview to visually inspect layout, contrast, face cropping, and mobile responsiveness.',
      parameters: obj({
        route: str({ description: 'Site route to capture, e.g. "/" or "/im-new" or "/sermons"' }),
        viewport: oneOf(['desktop', 'mobile']),
      }),
      execute: async (args) => {
        const cleanRoute = args.route.startsWith('/') ? args.route : `/${args.route}`;
        const base = opts.previewBase === '/' ? '' : opts.previewBase.replace(/\/$/, '');
        const url = `http://127.0.0.1:${opts.astroPort}${base}${cleanRoute}`;
        const size = args.viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 };

        const browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        try {
          const page = await browser.newPage({ viewport: size });
          await page.goto(url, { waitUntil: 'networkidle', timeout: 25_000 });
          await page.waitForTimeout(400);
          const png = await page.screenshot({ type: 'png', fullPage: false });
          return {
            output: [
              {
                type: 'text',
                text: `Captured ${args.viewport} (${size.width}x${size.height}) screenshot of ${cleanRoute}`,
              },
              {
                type: 'image',
                data: png.toString('base64'),
                mimeType: 'image/png',
              },
            ],
          };
        } finally {
          await browser.close();
        }
      },
    });

    const runChecksTool = defineTool({
      name: 'run_checks',
      description:
        'Run the full pre-publish verification suite (Astro Hygiene Guard, astro check, production build, verify:seo, etc.) against the repository.',
      parameters: obj({}),
      execute: async () => {
        const { allPassed, results } = await runAllVerificationChecks(opts.repoRoot);
        const summary = results
          .map((r) => `[${r.passed ? 'PASS' : 'FAIL'}] ${r.name} (${r.durationMs}ms)\n${r.output}`)
          .join('\n\n');
        return {
          output: [{ type: 'text', text: summary }],
          isError: !allPassed,
        };
      },
    });

    const editToolDef = createEditTool();
    const writeToolDef = createWriteTool();

    const wrapFileTool = <T extends typeof editToolDef | typeof writeToolDef>(toolDef: T) =>
      wrapTool(toolDef, (base) => ({
        ...base,
        execute: async (
          args: Parameters<typeof base.execute>[0],
          api: Parameters<typeof base.execute>[1],
          ctx: Parameters<typeof base.execute>[2],
        ) => {
          const target = String((args as Record<string, unknown>).path ?? '');
          const rel = path.relative(opts.repoRoot, path.resolve(opts.repoRoot, target)).split(path.sep).join('/');
          opts.onLockChange(true, rel);
          try {
            return await opts.fileLock.withLock(rel, () => base.execute(args as never, api, ctx));
          } finally {
            opts.onLockChange(false, rel);
          }
        },
      }));

    return defineExtension({
      name: 'halley',
      tools: [processImageTool, screenshotPageTool, runChecksTool],
      wraps: [wrapFileTool(editToolDef), wrapFileTool(writeToolDef)],
      sections: [
        section('halley_role', () => {
          const persona = opts.getPersona?.() ?? 'non-technical';
          const personaGuidance =
            persona === 'developer'
              ? [
                  'User Persona: Technical / Developer.',
                  'Be concise and direct. You may reference exact file paths, Astro components, Tailwind classes, and check outputs.',
                ]
              : [
                  'User Persona: Non-technical site maintainer (church staff / volunteer).',
                  'Prioritize ONLY the most important information the user needs to know—keep responses short (2–4 sentences or a couple of brief bullets).',
                  'Speak in warm, plain, everyday English about pages, sections, photos, and what visitors will see. NEVER mention technical details or lingo (no file paths like `src/pages/...`, no Astro/HTML/CSS/TypeScript/JSON/git terms, no component or script names, and no sitemap/robots internals) unless the user explicitly asks.',
                  'State what changed and any next step or question clearly (e.g., "I added your Spring Retreat page and kept it unlisted so it won\'t appear in menus or search. Take a look in the preview and let me know if you\'d like to add dates or photos!").',
                  'Summarize verification in plain terms ("Everything passed our site checks and is ready to publish").',
                ];
          return [
            'You are Halley, a friendly, careful AI website editor helping maintain an Astro website.',
            ...personaGuidance,
            'Never attempt to modify files under `.github/`. They are protected and read-only.',
            'When asked to create an unlisted or hidden page, create the `.astro` page under `src/pages/...`, do NOT link it in navigation menus, and mark it `indexable={false}` (or add `<meta name="robots" content="noindex" />`) and exclude it from the sitemap in `astro.config.mjs` if `@astrojs/sitemap` filter is used.',
            'When images are attached with a `stagedId`, use `process_image` to convert and save them cleanly into `public/images/...`.',
            'After significant layout or visual changes, use `screenshot_page` (desktop and mobile) to verify your work visually, and run `run_checks` to confirm `astro check`, `build`, and SEO checks pass.',
          ].join('\n');
        }),
        section('repo_agents_md', () =>
          agentsMdText ? `Repository AGENTS.md:\n\n${agentsMdText}` : undefined,
        ),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool: (call) => {
            if (call.name === 'edit' || call.name === 'write') {
              const args = call.arguments as Record<string, unknown>;
              const p = String(args.path ?? args.file_path ?? '');
              if (p && isProtectedPath(opts.repoRoot, p)) {
                return { block: '`.github/**` workflows are protected and cannot be modified.' };
              }
            }
            return undefined;
          },
        }),
        hook(GenerationTask, {
          afterRun: async (run, api, context) => {
            const { items } = await api.entries(
              { minEntryId: run.first, maxEntryId: run.last, order: 'ascending' },
              500,
              undefined,
              context,
            );
            const mutated = items.some((entry) => {
              if (!ToolResultEntry.is(entry)) return false;
              const msg = entry.model?.[0];
              if (!msg || msg.role !== 'toolResult') return false;
              return ['edit', 'write', 'bash', 'process_image'].includes(msg.toolName);
            });
            if (mutated) {
              await opts.onRunFinishedWithEdits('Update via Halley chat');
            }
            return undefined;
          },
        }),
      ],
    });
  }

  private mapWatchValue(value: NonNullable<typeof this.watchHandle>['value']): {
    entries: TranscriptEntryDto[];
    live: LiveRunStateDto;
    usageUsd: number;
  } {
    const entries: TranscriptEntryDto[] = [];

    for (const entry of value.entries) {
      if (UserEntry.is(entry)) {
        const textPart = entry.model?.[0]?.content;
        const display =
          typeof textPart === 'string'
            ? textPart
            : Array.isArray(textPart)
              ? textPart
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n')
              : '';
        entries.push({
          id: String(entry.id),
          kind: entry.kind,
          role: 'user',
          text: display,
        });
      } else if (AssistantEntry.is(entry)) {
        const msg = entry.model?.[0];
        const blocks = Array.isArray(msg?.content) ? msg.content : [];
        const text = blocks
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text.trim()) {
          entries.push({
            id: String(entry.id),
            kind: entry.kind,
            role: 'assistant',
            text,
          });
        }
      } else if (ToolResultEntry.is(entry)) {
        const msg = entry.model?.[0];
        if (msg && msg.role === 'toolResult') {
          const textOut = Array.isArray(msg.content)
            ? msg.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
            : '';
          entries.push({
            id: String(entry.id),
            kind: entry.kind,
            role: 'tool',
            text: textOut.slice(0, 600),
            toolName: msg.toolName,
            toolStatus: msg.isError ? 'error' : 'done',
            toolOutput: textOut.slice(0, 1200),
          });
        }
      }
    }

    const liveDoc = value.docs['pi.live'] as
      | {
          run?: unknown;
          generation?: { partial?: { content?: Array<{ type: string; text?: string }> } };
          tools?: Array<{ callId: string; name: string; output?: string; status: string }>;
          runFailure?: { reason: string; detail?: string };
        }
      | undefined;
    const gen = liveDoc?.generation;
    const streamingText =
      gen?.partial?.content
        ?.filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('') ?? undefined;

    const activeTools = (liveDoc?.tools ?? []).map((t) => ({
      callId: t.callId,
      name: t.name,
      summary: t.name,
      output: t.output?.slice(0, 600),
      status: t.status as LiveRunStateDto['activeTools'][number]['status'],
    }));

    const usageDoc = value.docs['pi.usage'];
    let usageUsd = 0;
    if (usageDoc?.models) {
      for (const u of Object.values(usageDoc.models)) {
        usageUsd += u.cost?.total ?? 0;
      }
    }

    const inboxDoc = value.docs['pi.inbox'] as { items?: unknown[] } | undefined;

    return {
      entries,
      live: {
        busy: Boolean(liveDoc?.run),
        streamingText,
        activeTools,
        queuedCount: inboxDoc?.items?.length ?? 0,
        runFailure: liveDoc?.runFailure
          ? {
              reason: liveDoc.runFailure.reason,
              detail: liveDoc.runFailure.detail ? String(liveDoc.runFailure.detail) : undefined,
            }
          : undefined,
      },
      usageUsd,
    };
  }

  async submitUserInput(input: {
    requestId: string;
    text: string;
    contextChips?: ElementContext[];
    attachments?: StagedAttachment[];
    whenBusy?: 'steer' | 'followUp';
  }): Promise<void> {
    const parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

    let enrichedText = input.text.trim();
    if (input.contextChips && input.contextChips.length > 0) {
      const chipLines = input.contextChips.map(
        (c, i) =>
          `[Selected Element ${i + 1}] file=${c.file} loc=${c.loc} route=${c.route} tag=<${c.tagName}> text=${JSON.stringify(c.renderedText)}`,
      );
      enrichedText = `${chipLines.join('\n')}\n\n${enrichedText}`;
    }

    if (input.attachments && input.attachments.length > 0) {
      const attachLines: string[] = [];
      const model = this.models.getModel('anthropic', this.resolvedModelId);
      const limits = imageLimits(model);

      for (const att of input.attachments) {
        attachLines.push(
          `[Uploaded Image] stagedId=${att.stagedId} filename=${JSON.stringify(att.filename)} mime=${att.mimeType}`,
        );
        const resolved = await this.opts.uploadManager.resolveStagedFile(att.stagedId);
        if (resolved) {
          const fitted = await fitImage(resolved.bytes, att.mimeType, limits, this.images);
          if (fitted.kind === 'fitted') {
            parts.push({
              type: 'image',
              data: fitted.image.data,
              mimeType: fitted.image.mimeType,
            });
          }
        }
      }
      enrichedText = `${attachLines.join('\n')}\n\n${enrichedText}`;
    }

    parts.unshift({ type: 'text', text: enrichedText });

    await this.root.submit(
      {
        type: 'input',
        requestId: input.requestId,
        content: parts,
        whenBusy: input.whenBusy,
      },
      BACKGROUND_CONTEXT,
    );
  }

  async submitConflictResolutionPrompt(conflictedFiles: string[]): Promise<boolean> {
    const sub = await this.root.submit(
      {
        type: 'input',
        requestId: `rebase-conflict-${Date.now()}`,
        content: [
          `A git rebase onto the latest live site branch hit merge conflicts in: ${conflictedFiles.join(', ')}.`,
          'Please inspect the conflict markers in those files, resolve them carefully preserving both our edits and the incoming live-site updates, stage each resolved file with `git add`, and do NOT run `git rebase --continue` yourself (Halley will run it once you finish). Confirm when all listed files are cleanly resolved.',
        ].join(' '),
      },
      BACKGROUND_CONTEXT,
    );
    const settled = await sub.wait(BACKGROUND_CONTEXT);
    return settled.status === 'done';
  }

  async abort(): Promise<void> {
    await this.root.abort(BACKGROUND_CONTEXT);
  }

  async continueRun(): Promise<void> {
    await this.root.submit({ type: 'continue' }, BACKGROUND_CONTEXT);
  }

  async stop(): Promise<void> {
    await this.watchHandle?.stop().catch(() => {});
    await this.harness?.close(BACKGROUND_CONTEXT).catch(() => {});
  }
}
