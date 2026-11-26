import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PerFileMutex } from '@halley/astro-dev-edit';
import { HALLEY_PLACEHOLDER_ATTR, type ChatServerMessage } from '@halley/shared';
import { describe, expect, it } from 'vitest';
import { FifoBuildQueue } from '../src/build-queue.js';
import { createCheckpoint, listCheckpoints, undoToCheckpoint } from '../src/checkpoints-and-git.js';
import { PageCreationService, PageValidationError } from '../src/pages.js';
import { runUnfinishedPagesCheck, runUnlistedIntegrityCheck } from '../src/verify.js';

const execFileAsync = promisify(execFile);

const identity = {
  botName: 'Halley Bot',
  botEmail: 'halley-bot@users.noreply.github.com',
  editorName: 'Sarah',
  editorEmail: 'sarah@thecrossing.website',
};

async function initTempAstroRepo(): Promise<{ repoDir: string; stateDir: string; baseSha: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-pages-test-'));
  const repoDir = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  await fs.mkdir(path.join(repoDir, 'src/layouts'), { recursive: true });
  await fs.mkdir(path.join(repoDir, 'src/pages/events'), { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });

  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

  await fs.writeFile(
    path.join(repoDir, 'src/layouts/BaseLayout.astro'),
    `---\nexport interface Props { title: string; description?: string; indexable?: boolean; }\n---\n<html><body><slot /></body></html>\n`,
  );
  await fs.writeFile(
    path.join(repoDir, 'src/pages/index.astro'),
    `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n<BaseLayout title="Home"><a href={url('/events/mens-retreat')}>Retreat</a></BaseLayout>\n`,
  );
  await fs.writeFile(
    path.join(repoDir, 'src/pages/events/mens-retreat.astro'),
    `---\nimport BaseLayout from '../../layouts/BaseLayout.astro';\n---\n<BaseLayout title="Men's Retreat" description="Annual retreat in the redwoods for men."><main><h1>Men's Retreat</h1></main></BaseLayout>\n`,
  );

  await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir });
  const baseSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
  return { repoDir, stateDir, baseSha };
}

describe('PageCreationService & verification checks', () => {
  it('creates skeleton with checkpoint, rejects collisions, supports undo, visibility toggle, rename, and delete', async () => {
    const { repoDir, stateDir, baseSha } = await initTempAstroRepo();
    const broadcasts: ChatServerMessage[] = [];
    const svc = new PageCreationService({
      repoRoot: repoDir,
      stateDir,
      baseBranch: 'main',
      gitIdentity: identity,
      fileLock: new PerFileMutex(),
      getAstroPort: () => 0,
      getPreviewBase: () => '/',
      onBroadcast: (m) => broadcasts.push(m),
    });

    try {
      // 1. Create unlisted page
      const created = await svc.createPage({
        title: 'Spring Retreat',
        slug: 'spring-retreat',
        section: '/events',
        styleLikeRoute: '/events/mens-retreat',
        unlisted: true,
        nav: { mode: 'none' },
      });
      expect(created.route).toBe('/events/spring-retreat');
      expect(created.file).toBe('src/pages/events/spring-retreat.astro');
      expect(created.pageRequest.status).toBe('writing');
      expect(created.checkpoint?.summary).toContain('Created page /events/spring-retreat');

      // Unfinished check fails while placeholder is present
      const unfinishedBefore = await runUnfinishedPagesCheck(repoDir);
      expect(unfinishedBefore.passed).toBe(false);
      expect(unfinishedBefore.output).toContain('spring-retreat.astro');

      // 2. Collision rejected with 409
      await expect(
        svc.createPage({
          title: 'Duplicate',
          slug: 'spring-retreat',
          section: '/events',
          unlisted: false,
          nav: { mode: 'none' },
        }),
      ).rejects.toThrow(PageValidationError);

      // 3. Toggle visibility to public
      const vis = await svc.setPageVisibility('/events/spring-retreat', false);
      expect(vis.unlisted).toBe(false);
      const afterUnhide = await fs.readFile(path.join(repoDir, created.file), 'utf8');
      expect(afterUnhide).not.toContain('indexable={false}');

      // 4. Rename URL from /events/mens-retreat -> /retreats/mens-camp (also updates url() reference in index.astro)
      const renamed = await svc.renamePage({
        fromRoute: '/events/mens-retreat',
        toSection: '/',
        toSlug: 'mens-camp',
      });
      expect(renamed.toRoute).toBe('/mens-camp');
      expect(renamed.updatedReferencesCount).toBeGreaterThanOrEqual(1);
      const movedContent = await fs.readFile(path.join(repoDir, 'src/pages/mens-camp.astro'), 'utf8');
      expect(movedContent).toContain("import BaseLayout from '../layouts/BaseLayout.astro';");
      const indexContent = await fs.readFile(path.join(repoDir, 'src/pages/index.astro'), 'utf8');
      expect(indexContent).toContain("url('/mens-camp')");

      // 5. Delete page
      const del = await svc.deletePage('/events/spring-retreat');
      expect(del.ok).toBe(true);
      await expect(fs.access(path.join(repoDir, created.file))).rejects.toThrow();

      // 6. Capped & busy statuses
      const cappedRes = await svc.createPage(
        { title: 'Capped Page', slug: 'capped-page', section: '/', unlisted: false, nav: { mode: 'none' } },
        { capped: true },
      );
      expect(cappedRes.pageRequest.status).toBe('capped');

      const busyRes = await svc.createPage(
        { title: 'Queued Page', slug: 'queued-page', section: '/', unlisted: false, nav: { mode: 'none' } },
        { isBusy: true },
      );
      expect(busyRes.pageRequest.status).toBe('queued');

      // 7. Undo back to baseSha cleanly removes created pages
      const history = await listCheckpoints(repoDir, baseSha);
      expect(history.length).toBeGreaterThanOrEqual(4);
      await undoToCheckpoint(repoDir, baseSha, identity);
      await expect(fs.access(path.join(repoDir, 'src/pages/capped-page.astro'))).rejects.toThrow();
    } finally {
      await fs.rm(path.dirname(repoDir), { recursive: true, force: true });
    }
  });

  it('verifies unlisted integrity against built dist/ HTML, sitemap, and nav', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-unlisted-verify-'));
    try {
      await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
      await fs.mkdir(path.join(tmp, 'dist/secret-event'), { recursive: true });

      await fs.writeFile(
        path.join(tmp, 'src/pages/secret-event.astro'),
        `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n<BaseLayout title="Secret" indexable={false}><main><h1>Secret</h1></main></BaseLayout>\n`,
      );

      // Passing state: has noindex, not in sitemap, not in nav
      await fs.writeFile(
        path.join(tmp, 'dist/secret-event/index.html'),
        `<html><head><meta name="robots" content="noindex" /></head><body><h1>Secret</h1></body></html>`,
      );
      await fs.writeFile(
        path.join(tmp, 'dist/sitemap-0.xml'),
        `<urlset><url><loc>https://example.org/</loc></url></urlset>`,
      );
      await fs.writeFile(
        path.join(tmp, 'dist/index.html'),
        `<html><body><header><nav><a href="/">Home</a></nav></header></body></html>`,
      );

      const passRes = await runUnlistedIntegrityCheck(tmp, '/');
      expect(passRes.passed).toBe(true);

      // Failing state: missing noindex, in sitemap, and linked in header
      await fs.writeFile(
        path.join(tmp, 'dist/secret-event/index.html'),
        `<html><head><title>Secret</title></head><body><h1>Secret</h1></body></html>`,
      );
      await fs.writeFile(
        path.join(tmp, 'dist/sitemap-0.xml'),
        `<urlset><url><loc>https://example.org/secret-event/</loc></url></urlset>`,
      );
      await fs.writeFile(
        path.join(tmp, 'dist/index.html'),
        `<html><body><header><nav><a href="/secret-event">Secret</a></nav></header></body></html>`,
      );

      const failRes = await runUnlistedIntegrityCheck(tmp, '/');
      expect(failRes.passed).toBe(false);
      expect(failRes.output).toContain('missing a <meta name="robots" content="noindex">');
      expect(failRes.output).toContain('dist/sitemap-0.xml');
      expect(failRes.output).toContain('linked from the site header/nav/footer');

      // Also check placeholder detection in dist/
      await fs.writeFile(
        path.join(tmp, 'dist/secret-event/index.html'),
        `<html><body><section ${HALLEY_PLACEHOLDER_ATTR}="true"></section></body></html>`,
      );
      const unfinished = await runUnfinishedPagesCheck(tmp);
      expect(unfinished.passed).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('syncs page requests from disk, toggles markdown visibility, blocks checkpoint during MERGE_HEAD, and enforces build lease TTL', async () => {
    const { repoDir, stateDir } = await initTempAstroRepo();
    try {
      const broadcasts: ChatServerMessage[] = [];
      const svc = new PageCreationService({
        repoRoot: repoDir,
        stateDir,
        baseBranch: 'main',
        gitIdentity: identity,
        fileLock: new PerFileMutex(),
        getAstroPort: () => 0,
        getPreviewBase: () => '/',
        onBroadcast: (msg) => broadcasts.push(msg),
      });
      await svc.load();

      // Create an unlisted page, then flip it public on disk (simulating Pi writing a public page)
      const created = await svc.createPage({
        title: 'Bigfoot',
        slug: 'bigfoot',
        section: '/',
        unlisted: true,
        nav: { mode: 'none' },
      });
      expect(created.pageRequest.unlisted).toBe(true);
      await fs.writeFile(
        path.join(repoDir, 'src/pages/bigfoot.astro'),
        `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n<BaseLayout title="Bigfoot"><main><h1>Bigfoot</h1></main></BaseLayout>\n`,
        'utf8',
      );
      await svc.syncPageRequestsFromDisk({ reconcileInterrupted: true, broadcast: true });
      const synced = svc.getPageRequest(created.pageRequest.pageRequestId);
      expect(synced?.unlisted).toBe(false);
      expect(synced?.status).toBe('done');
      expect(broadcasts.some((m) => m.type === 'page_requests_sync')).toBe(true);

      // Markdown page visibility toggle
      await fs.writeFile(
        path.join(repoDir, 'src/pages/notes.md'),
        `---\ntitle: Notes\n---\n# Notes\n`,
        'utf8',
      );
      const vis = await svc.setPageVisibility('/notes', true);
      expect(vis.unlisted).toBe(true);
      const mdContent = await fs.readFile(path.join(repoDir, 'src/pages/notes.md'), 'utf8');
      expect(mdContent).toContain('indexable: false');

      // createCheckpoint refuses to commit while MERGE_HEAD exists
      await fs.writeFile(path.join(repoDir, 'src/pages/conflict.astro'), '<<<<<<< HEAD\n', 'utf8');
      await fs.writeFile(path.join(repoDir, '.git/MERGE_HEAD'), 'deadbeef\n', 'utf8');
      const blocked = await createCheckpoint(repoDir, 'Should not commit', identity);
      expect(blocked).toBeNull();
      await fs.rm(path.join(repoDir, '.git/MERGE_HEAD'), { force: true });

      // FifoBuildQueue releases a stuck active lease automatically after maxLeaseMs
      const queue = new FifoBuildQueue(1000, 80);
      const lease1 = await queue.acquire('sess-stuck', { timeoutMs: 1000, priority: 'foreground' });
      const start = Date.now();
      const lease2 = await queue.acquire('sess-next', { timeoutMs: 1000, priority: 'foreground' });
      expect(Date.now() - start).toBeGreaterThanOrEqual(60);
      expect(lease1.leaseId).not.toBe(lease2.leaseId);
      lease2.release();
    } finally {
      await fs.rm(path.dirname(repoDir), { recursive: true, force: true });
    }
  });
});
