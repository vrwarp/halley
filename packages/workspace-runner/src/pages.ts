import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  discoverSiteStructure,
  extractNavGroupsFromHtml,
  generatePageSkeleton,
  isPageSourceUnlisted,
  rewriteRelativeImportsInAstroSource,
  toggleMarkdownUnlistedInSource,
  togglePageUnlistedInSource,
  type AsyncFileLock,
} from '@halley/astro-dev-edit';
import {
  CreatePageRequestSchema,
  HALLEY_PLACEHOLDER_ATTR,
  validateNewPageRoute,
  type ChatServerMessage,
  type CheckpointInfo,
  type CreatePageRequest,
  type CreatePageResultDto,
  type PageCreationOptionsDto,
  type PageRequestMetadata,
  type PageRequestStatus,
} from '@halley/shared';
import { detectAstroBase } from './astro-manager.js';
import {
  createCheckpoint,
  getGitChanges,
  type GitIdentity,
} from './checkpoints-and-git.js';

export class PageValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 409 = 400,
    public readonly collisionRoute?: string,
  ) {
    super(message);
    this.name = 'PageValidationError';
  }
}

export interface PageCreationServiceOptions {
  repoRoot: string;
  stateDir: string;
  baseBranch: string;
  gitIdentity: GitIdentity;
  fileLock: AsyncFileLock;
  getAstroPort: () => number;
  getPreviewBase: () => string;
  onBroadcast: (msg: ChatServerMessage) => void;
}

export class PageCreationService {
  private pageRequests = new Map<string, PageRequestMetadata>();
  private storePath: string;

  constructor(private opts: PageCreationServiceOptions) {
    this.storePath = path.join(opts.stateDir, 'page-requests.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      const arr = JSON.parse(raw) as PageRequestMetadata[];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item?.pageRequestId) {
            this.pageRequests.set(item.pageRequestId, item);
          }
        }
      }
    } catch {
      // no persisted page requests yet
    }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(this.opts.stateDir, { recursive: true });
      await fs.writeFile(
        this.storePath,
        JSON.stringify(Array.from(this.pageRequests.values()), null, 2),
        'utf8',
      );
    } catch {
      // non-fatal
    }
  }

  listPageRequests(): PageRequestMetadata[] {
    return Array.from(this.pageRequests.values()).sort(
      (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
  }

  getPageRequest(id: string): PageRequestMetadata | undefined {
    return this.pageRequests.get(id);
  }

  findLatestByRoute(route: string): PageRequestMetadata | undefined {
    const list = this.listPageRequests().reverse();
    return list.find((p) => p.route === route);
  }

  findActiveByRoute(route: string): PageRequestMetadata | undefined {
    const list = this.listPageRequests().reverse();
    return list.find(
      (p) =>
        p.route === route &&
        (p.status === 'created' ||
          p.status === 'queued' ||
          p.status === 'writing' ||
          p.status === 'photo' ||
          p.status === 'menu'),
    );
  }

  /**
   * Reconciles stored PageRequestMetadata against the actual files on disk:
   * - Removes entries whose page file was deleted (e.g. via Undo or Revert-file).
   * - Re-computes `unlisted` from the actual file source so cards never disagree with the toolbar.
   * - When `reconcileInterrupted` is true (e.g. after runner restart/sleep), resolves any stuck
   *   in-progress spinner (`created`/`queued`/`writing`/`photo`/`menu`) to `done` or `failed`.
   */
  async syncPageRequestsFromDisk(opts?: {
    reconcileInterrupted?: boolean;
    broadcast?: boolean;
  }): Promise<boolean> {
    let changed = false;
    const activeStatuses = new Set<PageRequestStatus>([
      'created',
      'queued',
      'writing',
      'photo',
      'menu',
    ]);

    for (const [id, pr] of Array.from(this.pageRequests.entries())) {
      const abs = path.join(this.opts.repoRoot, pr.file);
      let src: string;
      try {
        src = await fs.readFile(abs, 'utf8');
      } catch {
        this.pageRequests.delete(id);
        changed = true;
        continue;
      }

      const ext = path.extname(pr.file);
      const actualUnlisted = await isPageSourceUnlisted(src, ext).catch(() => pr.unlisted);
      let nextStatus = pr.status;
      let nextError = pr.error;

      if (opts?.reconcileInterrupted && activeStatuses.has(pr.status)) {
        if (src.includes(HALLEY_PLACEHOLDER_ATTR)) {
          nextStatus = 'failed';
          nextError = 'Workspace restarted before finishing this page.';
        } else {
          nextStatus = 'done';
          nextError = undefined;
        }
      }

      if (actualUnlisted !== pr.unlisted || nextStatus !== pr.status || nextError !== pr.error) {
        this.pageRequests.set(id, {
          ...pr,
          unlisted: actualUnlisted,
          status: nextStatus,
          error: nextError,
        });
        changed = true;
      }
    }

    if (changed) {
      await this.save();
      if (opts?.broadcast !== false) {
        this.opts.onBroadcast({
          type: 'page_requests_sync',
          pageRequests: this.listPageRequests(),
        });
      }
    }
    return changed;
  }

  async updateStatus(
    pageRequestId: string,
    status: PageRequestStatus,
    error?: string,
  ): Promise<PageRequestMetadata | undefined> {
    const existing = this.pageRequests.get(pageRequestId);
    if (!existing) return undefined;
    let nextUnlisted = existing.unlisted;
    if (status === 'done') {
      try {
        const src = await fs.readFile(path.join(this.opts.repoRoot, existing.file), 'utf8');
        nextUnlisted = await isPageSourceUnlisted(src, path.extname(existing.file));
      } catch {
        // keep existing
      }
    }
    const updated: PageRequestMetadata = {
      ...existing,
      unlisted: nextUnlisted,
      status,
      error: error ?? (status === 'failed' ? existing.error : undefined),
    };
    this.pageRequests.set(pageRequestId, updated);
    await this.save();
    this.opts.onBroadcast({
      type: 'page_request_state',
      pageRequest: updated,
    });
    return updated;
  }

  async getPageCreationOptions(capped: boolean): Promise<PageCreationOptionsDto> {
    const structure = await discoverSiteStructure(this.opts.repoRoot);
    let navGroups: string[] = [];
    try {
      const port = this.opts.getAstroPort();
      const base = this.opts.getPreviewBase();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}${base}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const html = await res.text();
          navGroups = extractNavGroupsFromHtml(html);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // preview may not be serving yet
    }

    return {
      sections: structure.sections,
      routes: structure.routes,
      dynamicPatterns: structure.dynamicPatterns,
      generatedRoutes: structure.generatedRoutes,
      navGroups,
      capped,
    };
  }

  buildPiInstructions(
    req: CreatePageRequest,
    route: string,
    targetFileRel: string,
    usedReferenceFile?: string,
  ): string {
    const lines: string[] = [
      `A new starter page has already been created at \`${targetFileRel}\` (route \`${route}\`) with title "${req.title}".`,
      `Your job is to replace the temporary \`${HALLEY_PLACEHOLDER_ATTR}\` section in \`${targetFileRel}\` with complete, well-written, on-brand content.`,
    ];

    if (req.purpose?.trim()) {
      lines.push(`Page purpose & content notes from the editor:\n${req.purpose.trim()}`);
    } else {
      lines.push(
        `No detailed description was provided yet—draft clean, welcoming starter content fitting "${req.title}" and let the editor know what details they may want to customize.`,
      );
    }

    if (req.styleLikeRoute && req.styleLikeRoute !== '__blank__' && usedReferenceFile) {
      lines.push(
        `Design reference: read \`${usedReferenceFile}\` and match its layout structure, typography, spacing, and visual style while writing fresh content for "${req.title}".`,
      );
    } else if (req.styleLikeRoute === '__blank__') {
      lines.push(
        `Design style: start clean using the site's layout and typography conventions (see AGENTS.md if present).`,
      );
    }

    lines.push(
      `Update the page's SEO \`description\` prop/meta tag (30–160 characters) based on the page content, and use the site's \`url()\` helper for all internal links and \`/images/...\` assets if the site uses a base subpath.`,
    );

    if (req.attachment) {
      const sectionSlug =
        req.section && req.section !== '/'
          ? req.section.replace(/^\/+/, '').split('/')[0] || 'pages'
          : 'pages';
      const leafSlug = route.split('/').filter(Boolean).pop() || 'hero';
      const destPath = `public/images/${sectionSlug}/${leafSlug}.webp`;
      lines.push(
        `Hero photo attached: call \`process_image\` with \`stagedId="${req.attachment.stagedId}"\` and \`destPath="${destPath}"\`, then place it in the page's hero/header slot (matching the reference page's hero placement, or adding a clean hero banner in the site's style if the reference page has none). Write descriptive alt text and mention the alt text in your reply.`,
      );
    }

    if (req.unlisted) {
      lines.push(
        `Unlisted page requirements: keep \`indexable={false}\` (or \`<meta name="robots" content="noindex" />\`), do NOT link this page in any navigation menu or footer, and exclude \`${route}\` from the sitemap filter in \`astro.config.mjs\` if \`@astrojs/sitemap\` uses a filter.`,
      );
    } else if (req.nav.mode === 'group') {
      lines.push(
        `Navigation menu: add a link to \`${route}\` titled "${req.title}" under the "${req.nav.group}" navigation group (inspect the site's navigation data/header component to follow its exact structure).`,
      );
    }

    lines.push(
      `IMPORTANT: Remove the \`${HALLEY_PLACEHOLDER_ATTR}\` section completely once you write the real content. In your reply, link to the page as \`[${req.title}](${route})\`.`,
    );

    return lines.join('\n\n');
  }

  async createPage(
    rawInput: unknown,
    execOpts: {
      fromPiTool?: boolean;
      capped?: boolean;
      isBusy?: boolean;
    } = {},
  ): Promise<CreatePageResultDto & { instructions: string }> {
    const req = CreatePageRequestSchema.parse(rawInput);
    const effectiveNav = req.unlisted ? ({ mode: 'none' } as const) : req.nav;
    const normalizedReq: CreatePageRequest = { ...req, nav: effectiveNav };

    const structure = await discoverSiteStructure(this.opts.repoRoot);
    const validation = validateNewPageRoute({
      section: normalizedReq.section,
      slug: normalizedReq.slug,
      existingRoutes: structure.routes.map((r) => r.route),
      dynamicPatterns: structure.dynamicPatterns,
      generatedRoutes: structure.generatedRoutes,
    });

    if (!validation.valid) {
      throw new PageValidationError(
        validation.error || 'Invalid page URL.',
        validation.collisionRoute ? 409 : 400,
        validation.collisionRoute,
      );
    }

    const route = validation.route;
    const targetFileRel = `src/pages${route}.astro`;
    const targetFileAbs = path.join(this.opts.repoRoot, targetFileRel);
    const pagesRootAbs = path.resolve(this.opts.repoRoot, 'src', 'pages');
    if (!path.resolve(targetFileAbs).startsWith(pagesRootAbs + path.sep)) {
      throw new PageValidationError('Invalid target page path.', 400);
    }

    const skeleton = await generatePageSkeleton({
      repoRoot: this.opts.repoRoot,
      title: normalizedReq.title,
      route,
      targetFileRel,
      styleLikeRoute: normalizedReq.styleLikeRoute,
      unlisted: normalizedReq.unlisted,
      purpose: normalizedReq.purpose,
    });

    await this.opts.fileLock.withLock(targetFileRel, async () => {
      await fs.mkdir(path.dirname(targetFileAbs), { recursive: true });
      const tmp = `${targetFileAbs}.tmp-${Date.now()}`;
      await fs.writeFile(tmp, skeleton.content, 'utf8');
      await fs.rename(tmp, targetFileAbs);
    });

    const checkpoint: CheckpointInfo | null = await createCheckpoint(
      this.opts.repoRoot,
      `Created page ${route}`,
      this.opts.gitIdentity,
    );
    const changes = await getGitChanges(
      this.opts.repoRoot,
      `origin/${this.opts.baseBranch}`,
    ).catch(() => []);

    if (checkpoint) {
      this.opts.onBroadcast({
        type: 'checkpoint_created',
        checkpoint,
        changedFilesCount: changes.length,
      });
    }

    const instructions = this.buildPiInstructions(
      normalizedReq,
      route,
      targetFileRel,
      skeleton.usedReferenceFile,
    );

    const initialStatus: PageRequestStatus = execOpts.fromPiTool
      ? 'writing'
      : execOpts.capped
        ? 'capped'
        : execOpts.isBusy
          ? 'queued'
          : 'writing';

    const pageRequest: PageRequestMetadata = {
      pageRequestId: crypto.randomUUID(),
      title: normalizedReq.title,
      route,
      file: targetFileRel,
      section: normalizedReq.section || '/',
      purpose: normalizedReq.purpose?.trim() || undefined,
      styleLikeRoute: normalizedReq.styleLikeRoute,
      nav: effectiveNav,
      unlisted: normalizedReq.unlisted,
      attachment: normalizedReq.attachment,
      status: initialStatus,
      instructions,
      createdAt: Date.now(),
    };

    this.pageRequests.set(pageRequest.pageRequestId, pageRequest);
    await this.save();

    this.opts.onBroadcast({
      type: 'page_request_state',
      pageRequest,
      autoNavigate: true,
    });

    return {
      ok: true,
      route,
      file: targetFileRel,
      pageRequest,
      checkpoint,
      changedFilesCount: changes.length,
      instructions,
    };
  }

  async deletePage(route: string): Promise<{ ok: true; deletedFile: string; checkpoint: CheckpointInfo | null }> {
    const clean = route.startsWith('/') ? route.replace(/\/+$/, '') : `/${route.replace(/\/+$/, '')}`;
    if (!clean || clean === '/') {
      throw new PageValidationError('Cannot delete the homepage.', 400);
    }

    const candidates = [
      `src/pages${clean}.astro`,
      `src/pages${clean}/index.astro`,
      `src/pages${clean}.md`,
      `src/pages${clean}.mdx`,
    ];
    const pagesRootAbs = path.resolve(this.opts.repoRoot, 'src', 'pages');

    let foundRel: string | null = null;
    for (const rel of candidates) {
      const abs = path.resolve(this.opts.repoRoot, rel);
      if (!abs.startsWith(pagesRootAbs + path.sep)) continue;
      try {
        await fs.access(abs);
        foundRel = rel;
        break;
      } catch {
        // try next
      }
    }

    if (!foundRel) {
      throw new PageValidationError(`Page file for ${clean} not found.`, 400);
    }

    const abs = path.resolve(this.opts.repoRoot, foundRel);
    await this.opts.fileLock.withLock(foundRel, async () => {
      await fs.unlink(abs);
    });

    // Remove matching page request cards so deleted pages don't linger
    for (const [id, pr] of this.pageRequests.entries()) {
      if (pr.route === clean) {
        this.pageRequests.delete(id);
      }
    }
    await this.save();

    const checkpoint = await createCheckpoint(
      this.opts.repoRoot,
      `Deleted page ${clean}`,
      this.opts.gitIdentity,
    );
    const changes = await getGitChanges(
      this.opts.repoRoot,
      `origin/${this.opts.baseBranch}`,
    ).catch(() => []);

    if (checkpoint) {
      this.opts.onBroadcast({
        type: 'checkpoint_created',
        checkpoint,
        changedFilesCount: changes.length,
      });
    }
    this.opts.onBroadcast({
      type: 'page_requests_sync',
      pageRequests: this.listPageRequests(),
    });

    return { ok: true, deletedFile: foundRel, checkpoint };
  }

  private async resolvePageFile(route: string): Promise<{ fileRel: string; fileAbs: string; ext: string } | null> {
    const clean = route === '/' ? '/' : route.startsWith('/') ? route.replace(/\/+$/, '') : `/${route.replace(/\/+$/, '')}`;
    const pagesRootAbs = path.resolve(this.opts.repoRoot, 'src', 'pages');
    const candidates =
      clean === '/'
        ? ['src/pages/index.astro', 'src/pages/index.md', 'src/pages/index.mdx']
        : [
            `src/pages${clean}.astro`,
            `src/pages${clean}/index.astro`,
            `src/pages${clean}.md`,
            `src/pages${clean}.mdx`,
          ];
    for (const rel of candidates) {
      const abs = path.resolve(this.opts.repoRoot, rel);
      if (!abs.startsWith(pagesRootAbs + path.sep)) continue;
      try {
        await fs.access(abs);
        return { fileRel: rel, fileAbs: abs, ext: path.extname(rel) };
      } catch {
        // try next
      }
    }
    return null;
  }

  async setPageVisibility(
    route: string,
    unlisted: boolean,
  ): Promise<{
    ok: true;
    route: string;
    unlisted: boolean;
    file: string;
    checkpoint: CheckpointInfo | null;
    changedFilesCount: number;
    followUpPrompt?: string;
  }> {
    const clean = route.startsWith('/') ? route.replace(/\/+$/, '') : `/${route.replace(/\/+$/, '')}`;
    if (!clean || clean === '/') {
      throw new PageValidationError('Cannot mark the homepage as unlisted.', 400);
    }
    const found = await this.resolvePageFile(clean);
    if (!found) {
      throw new PageValidationError(`Page file for ${clean} not found.`, 400);
    }

    await this.opts.fileLock.withLock(found.fileRel, async () => {
      const src = await fs.readFile(found.fileAbs, 'utf8');
      const updated =
        found.ext === '.astro'
          ? await togglePageUnlistedInSource(src, found.fileAbs, unlisted)
          : found.ext === '.md' || found.ext === '.mdx'
            ? toggleMarkdownUnlistedInSource(src, unlisted)
            : src;
      if (updated !== src) {
        const tmp = `${found.fileAbs}.tmp-${Date.now()}`;
        await fs.writeFile(tmp, updated, 'utf8');
        await fs.rename(tmp, found.fileAbs);
      }
    });

    // Update any stored PageRequestMetadata for this route
    let prUpdated = false;
    for (const [id, pr] of this.pageRequests.entries()) {
      if (pr.route === clean) {
        this.pageRequests.set(id, { ...pr, unlisted });
        prUpdated = true;
      }
    }
    await this.save();

    const summary = unlisted ? `Marked ${clean} as unlisted` : `Made ${clean} public`;
    const checkpoint = await createCheckpoint(this.opts.repoRoot, summary, this.opts.gitIdentity);
    const changes = await getGitChanges(
      this.opts.repoRoot,
      `origin/${this.opts.baseBranch}`,
    ).catch(() => []);

    if (checkpoint) {
      this.opts.onBroadcast({
        type: 'checkpoint_created',
        checkpoint,
        changedFilesCount: changes.length,
      });
    }
    if (prUpdated) {
      this.opts.onBroadcast({
        type: 'page_requests_sync',
        pageRequests: this.listPageRequests(),
      });
    }

    // Check if astro.config.mjs has a sitemap filter or if scripts/verify-seo.mjs tracks non-indexable routes
    let needsFollowUp = false;
    try {
      const astroCfg = await fs
        .readFile(path.join(this.opts.repoRoot, 'astro.config.mjs'), 'utf8')
        .catch(() => '');
      if (/sitemap/i.test(astroCfg) && /filter/i.test(astroCfg)) {
        needsFollowUp = true;
      }
    } catch {
      // ignore
    }

    const followUpPrompt = needsFollowUp
      ? unlisted
        ? `The page \`${clean}\` (${found.fileRel}) was just marked as unlisted (noindex is already set on the page). Please check \`astro.config.mjs\` to exclude \`${clean}\` from the sitemap filter if applicable, update \`scripts/verify-seo.mjs\` (\`NON_INDEXABLE_ROUTES\`) if present, and remove any navigation menu or footer links pointing to \`${clean}\`.`
        : `The page \`${clean}\` (${found.fileRel}) was just made public (noindex was removed from the page). If \`astro.config.mjs\` explicitly excludes \`${clean}\` from the sitemap filter or \`scripts/verify-seo.mjs\` lists it in \`NON_INDEXABLE_ROUTES\`, please remove that exclusion.`
      : undefined;

    return {
      ok: true,
      route: clean,
      unlisted,
      file: found.fileRel,
      checkpoint,
      changedFilesCount: changes.length,
      followUpPrompt,
    };
  }

  async renamePage(input: {
    fromRoute: string;
    toSection: string;
    toSlug: string;
  }): Promise<{
    ok: true;
    fromRoute: string;
    toRoute: string;
    file: string;
    updatedReferencesCount: number;
    checkpoint: CheckpointInfo | null;
    changedFilesCount: number;
  }> {
    const cleanFrom = input.fromRoute.startsWith('/')
      ? input.fromRoute.replace(/\/+$/, '')
      : `/${input.fromRoute.replace(/\/+$/, '')}`;
    if (!cleanFrom || cleanFrom === '/') {
      throw new PageValidationError('Cannot change the URL of the homepage.', 400);
    }

    const found = await this.resolvePageFile(cleanFrom);
    if (!found) {
      throw new PageValidationError(`Page file for ${cleanFrom} not found.`, 400);
    }

    const structure = await discoverSiteStructure(this.opts.repoRoot);
    const validation = validateNewPageRoute({
      section: input.toSection,
      slug: input.toSlug,
      existingRoutes: structure.routes.map((r) => r.route),
      dynamicPatterns: structure.dynamicPatterns,
      generatedRoutes: structure.generatedRoutes,
    });

    if (!validation.valid) {
      throw new PageValidationError(
        validation.error || 'Invalid target URL.',
        validation.collisionRoute ? 409 : 400,
        validation.collisionRoute,
      );
    }

    const toRoute = validation.route;
    const toFileRel = `src/pages${toRoute}${found.ext}`;
    const toFileAbs = path.join(this.opts.repoRoot, toFileRel);
    const pagesRootAbs = path.resolve(this.opts.repoRoot, 'src', 'pages');
    if (!path.resolve(toFileAbs).startsWith(pagesRootAbs + path.sep)) {
      throw new PageValidationError('Invalid target page path.', 400);
    }

    await this.opts.fileLock.withLock(found.fileRel, async () => {
      const src = await fs.readFile(found.fileAbs, 'utf8');
      const nextSrc =
        found.ext === '.astro'
          ? rewriteRelativeImportsInAstroSource(src, found.fileAbs, toFileAbs)
          : src;
      await fs.mkdir(path.dirname(toFileAbs), { recursive: true });
      const tmp = `${toFileAbs}.tmp-${Date.now()}`;
      await fs.writeFile(tmp, nextSrc, 'utf8');
      await fs.rename(tmp, toFileAbs);
      if (path.resolve(found.fileAbs) !== path.resolve(toFileAbs)) {
        await fs.unlink(found.fileAbs);
      }
    });

    // Deterministically update exact internal references (including #hash, ?query, trailing /, and base-prefixed config entries)
    const originalBase = await detectAstroBase(this.opts.repoRoot).catch(() => '/');
    const basePrefix = originalBase === '/' ? '' : originalBase.replace(/\/$/, '');
    let updatedReferencesCount = 0;
    const escapedFrom = cleanFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const refPatterns = [
      new RegExp(`(url\\(\\s*['"])${escapedFrom}((?:\\/|#[^'"]*|\\?[^'"]*)?['"]\\s*\\))`, 'g'),
      new RegExp(`(\\bhref\\s*:\\s*['"])${escapedFrom}((?:\\/|#[^'"]*|\\?[^'"]*)?['"])`, 'g'),
      new RegExp(`(\\bhref\\s*=\\s*['"])${escapedFrom}((?:\\/|#[^'"]*|\\?[^'"]*)?['"])`, 'g'),
    ];

    const filesToUpdate: string[] = [];
    const walkSrc = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walkSrc(full);
        } else if (/\.(astro|ts|tsx|js|mjs|cjs|json|mdx?)$/.test(e.name)) {
          filesToUpdate.push(full);
        }
      }
    };
    await walkSrc(path.join(this.opts.repoRoot, 'src'));
    const astroCfgAbs = path.join(this.opts.repoRoot, 'astro.config.mjs');
    if (await fs.access(astroCfgAbs).then(() => true).catch(() => false)) {
      filesToUpdate.push(astroCfgAbs);
    }
    const verifySeoAbs = path.join(this.opts.repoRoot, 'scripts', 'verify-seo.mjs');
    if (await fs.access(verifySeoAbs).then(() => true).catch(() => false)) {
      filesToUpdate.push(verifySeoAbs);
    }

    const escapedBaseFrom = basePrefix
      ? `${basePrefix}${cleanFrom}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : null;

    for (const abs of filesToUpdate) {
      const rel = path.relative(this.opts.repoRoot, abs).split(path.sep).join('/');
      await this.opts.fileLock
        .withLock(rel, async () => {
          const text = await fs.readFile(abs, 'utf8');
          let next = text;
          for (const re of refPatterns) {
            next = next.replace(re, `$1${toRoute}$2`);
          }
          if (abs === astroCfgAbs || abs === verifySeoAbs) {
            if (escapedBaseFrom) {
              next = next.replace(
                new RegExp(`(['"])${escapedBaseFrom}(\\/?['"])`, 'g'),
                `$1${basePrefix}${toRoute}$2`,
              );
            }
            // Replace bare route strings while avoiding `base: '/...'`
            next = next.replace(
              new RegExp(`(?<!\\bbase\\s*:\\s*)(['"])${escapedFrom}(\\/?['"])`, 'g'),
              `$1${toRoute}$2`,
            );
          }
          if (next !== text) {
            const tmp = `${abs}.halley-tmp-${process.pid}-${Date.now()}`;
            await fs.writeFile(tmp, next, 'utf8');
            await fs.rename(tmp, abs);
            updatedReferencesCount += 1;
          }
        })
        .catch(() => {});
    }

    // Update any stored PageRequestMetadata for this route (including section)
    const nextSection = input.toSection || '/';
    for (const [id, pr] of this.pageRequests.entries()) {
      if (pr.route === cleanFrom) {
        this.pageRequests.set(id, { ...pr, route: toRoute, file: toFileRel, section: nextSection });
      }
    }
    await this.save();

    const checkpoint = await createCheckpoint(
      this.opts.repoRoot,
      `Moved page ${cleanFrom} to ${toRoute}`,
      this.opts.gitIdentity,
    );
    const changes = await getGitChanges(
      this.opts.repoRoot,
      `origin/${this.opts.baseBranch}`,
    ).catch(() => []);

    if (checkpoint) {
      this.opts.onBroadcast({
        type: 'checkpoint_created',
        checkpoint,
        changedFilesCount: changes.length,
      });
    }
    this.opts.onBroadcast({
      type: 'page_requests_sync',
      pageRequests: this.listPageRequests(),
    });

    return {
      ok: true,
      fromRoute: cleanFrom,
      toRoute,
      file: toFileRel,
      updatedReferencesCount,
      checkpoint,
      changedFilesCount: changes.length,
    };
  }

  async fileStillHasPlaceholder(fileRel: string): Promise<boolean> {
    try {
      const content = await fs.readFile(path.join(this.opts.repoRoot, fileRel), 'utf8');
      return content.includes(HALLEY_PLACEHOLDER_ATTR);
    } catch {
      return false;
    }
  }
}
