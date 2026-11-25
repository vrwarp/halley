import { execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AstroDevManager } from '../src/astro-manager.js';
import {
  createCheckpoint,
  hasProtectedPathChanges,
  listCheckpoints,
  mergeWithBase,
  rebaseOnBase,
  sanitizeProtectedPaths,
  undoToCheckpoint,
} from '../src/checkpoints-and-git.js';
import { UploadManager } from '../src/uploads.js';
import { runAllVerificationChecks, runAstroHygieneGuard } from '../src/verify.js';

const execFileAsync = promisify(execFile);

const identity = {
  botName: 'Halley Bot',
  botEmail: 'halley-bot@users.noreply.github.com',
  editorName: 'Sarah',
  editorEmail: 'sarah@thecrossing.website',
};

describe('workspace-runner git, protection & hygiene', () => {
  it('protects .github/** from rogue edits, creates checkpoints with Co-authored-by, and supports undo', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-ws-test-'));
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });

      await fs.mkdir(path.join(tmp, '.github/workflows'), { recursive: true });
      await fs.writeFile(path.join(tmp, '.github/workflows/ci.yml'), 'name: CI\n');
      await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<p>Initial</p>\n');
      await execFileAsync('git', ['add', '-A'], { cwd: tmp });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmp });

      const { stdout: baseShaRaw } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tmp });
      const baseSha = baseShaRaw.trim();

      // Simulate rogue bash edit to .github/workflows/ci.yml + legitimate page edit
      await fs.writeFile(path.join(tmp, '.github/workflows/ci.yml'), 'name: HACKED\n');
      await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<p>Updated</p>\n');

      const ckpt1 = await createCheckpoint(tmp, 'Update homepage', identity);
      expect(ckpt1).not.toBeNull();

      // Verify .github/workflows/ci.yml was automatically restored
      const ciContent = await fs.readFile(path.join(tmp, '.github/workflows/ci.yml'), 'utf8');
      expect(ciContent).toBe('name: CI\n');
      expect(await hasProtectedPathChanges(tmp, baseSha)).toEqual([]);

      // Verify Co-authored-by trailer
      const { stdout: commitBody } = await execFileAsync('git', ['log', '-1', '--format=%B'], { cwd: tmp });
      expect(commitBody).toContain('Co-authored-by: Sarah <sarah@thecrossing.website>');

      // Second edit & undo back to baseSha
      await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<p>Updated 2</p>\n');
      await createCheckpoint(tmp, 'Second update', identity);

      const history = await listCheckpoints(tmp, baseSha);
      expect(history.length).toBe(2);

      await undoToCheckpoint(tmp, baseSha, identity);
      const restored = await fs.readFile(path.join(tmp, 'src/pages/index.astro'), 'utf8');
      expect(restored).toBe('<p>Initial</p>\n');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('hygiene guard catches hardcoded root-relative links and missing public assets (images & PDFs)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-hygiene-test-'));
    try {
      await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
      await fs.mkdir(path.join(tmp, 'public/images'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'src/pages/index.astro'),
        [
          `<a href="/im-new">Visit</a>`,
          `<a href={url('/im-new')}>Safe route</a>`,
          `<img src={url('/images/missing.webp')} />`,
          `<a href={url('/docs/bulletin.pdf')}>Bulletin</a>`,
        ].join('\n'),
      );

      const res = await runAstroHygieneGuard(tmp, '/thecrossing.website');
      expect(res.passed).toBe(false);
      expect(res.output).toContain('hardcoded root-relative path');
      expect(res.output).toContain('missing public asset /images/missing.webp');
      expect(res.output).toContain('missing public asset /docs/bulletin.pdf');
      expect(res.output).not.toContain('missing public asset /im-new');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('merges cleanly, resolves multi-checkpoint conflicts once, rejects leftover markers, and preserves live updates on post-sync undo', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-merge-test-'));
    try {
      const bare = path.join(tmp, 'remote.git');
      const wsA = path.join(tmp, 'wsA');
      const wsB = path.join(tmp, 'wsB');

      await execFileAsync('git', ['init', '--bare', '-b', 'main', bare]);
      await execFileAsync('git', ['clone', bare, wsA]);
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: wsA });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsA });
      await fs.writeFile(path.join(wsA, 'page.txt'), 'line 1\n');
      await fs.writeFile(path.join(wsA, 'other.txt'), 'other initial\n');
      await execFileAsync('git', ['add', '-A'], { cwd: wsA });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: wsA });
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: wsA });

      // Clone wsB on a feature branch and make TWO checkpoints touching page.txt
      await execFileAsync('git', ['clone', bare, wsB]);
      await execFileAsync('git', ['checkout', '-b', 'halley/edit-1'], { cwd: wsB });
      await fs.writeFile(path.join(wsB, 'page.txt'), 'line 1 (editor B v1)\n');
      const ckptB1 = await createCheckpoint(wsB, 'Edit B v1', identity);
      expect(ckptB1).not.toBeNull();

      await fs.writeFile(path.join(wsB, 'page.txt'), 'line 1 (editor B v2)\n');
      await createCheckpoint(wsB, 'Edit B v2', identity);

      // Advance main in wsA: modify both page.txt (conflicts) and other.txt (non-conflicting)
      await fs.writeFile(path.join(wsA, 'page.txt'), 'line 1 (editor A)\n');
      await fs.writeFile(path.join(wsA, 'other.txt'), 'other updated by Grace\n');
      await execFileAsync('git', ['add', '-A'], { cwd: wsA });
      await execFileAsync('git', ['commit', '-m', 'Grace live update'], { cwd: wsA });
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: wsA });

      // 1. If resolver leaves conflict markers behind, mergeWithBase must reject and abort cleanly
      const badOutcome = await mergeWithBase(wsB, {
        baseBranch: 'main',
        identity,
        onResolveConflict: async (files) => {
          expect(files).toEqual(['page.txt']);
          await fs.writeFile(path.join(wsB, 'page.txt'), '<<<<<<< HEAD\nbad\n=======\nstill bad\n>>>>>>> main\n');
          await execFileAsync('git', ['add', 'page.txt'], { cwd: wsB });
          return true;
        },
      });
      expect(badOutcome.status).toBe('conflict');
      // Working tree must be cleanly aborted (no MERGE_HEAD)
      const mergeHeadExists = await fs
        .access(path.join(wsB, '.git', 'MERGE_HEAD'))
        .then(() => true)
        .catch(() => false);
      expect(mergeHeadExists).toBe(false);

      // 2. Resolver runs ONCE (not twice for 2 checkpoints) and succeeds cleanly
      let resolverCalls = 0;
      const outcome = await rebaseOnBase(wsB, {
        baseBranch: 'main',
        identity,
        onResolveConflict: async (files) => {
          resolverCalls++;
          expect(files).toEqual(['page.txt']);
          await fs.writeFile(path.join(wsB, 'page.txt'), 'line 1 (A + B v2)\n');
          await execFileAsync('git', ['add', 'page.txt'], { cwd: wsB });
          return true;
        },
      });
      expect(outcome.status).toBe('resolved');
      expect(resolverCalls).toBe(1);
      expect(outcome.newBaseSha).toBeTruthy();
      expect(await fs.readFile(path.join(wsB, 'page.txt'), 'utf8')).toBe('line 1 (A + B v2)\n');
      expect(await fs.readFile(path.join(wsB, 'other.txt'), 'utf8')).toBe('other updated by Grace\n');

      // 3. listCheckpoints with newBaseSha uses --first-parent: excludes Grace's upstream commit and marks sync boundary
      const ckpts = await listCheckpoints(wsB, outcome.newBaseSha!);
      expect(ckpts.some((c) => c.message.includes('Grace live update'))).toBe(false);
      expect(ckpts[0]?.isSyncBoundary).toBe(true);
      expect(ckpts.some((c) => c.summary === 'Edit B v1')).toBe(true);

      // 4. Undo to pre-sync checkpoint ckptB1 must PRESERVE Grace's live update to other.txt!
      await undoToCheckpoint(wsB, ckptB1!.sha, identity);
      expect(await fs.readFile(path.join(wsB, 'other.txt'), 'utf8')).toBe('other updated by Grace\n');
      expect(await sanitizeProtectedPaths(wsB)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('strips EXIF/GPS metadata at upload time while applying EXIF orientation', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-upload-test-'));
    try {
      // Create a 40x20 JPEG with EXIF Orientation=6 (90deg CW -> upright 20x40) and GPS/EXIF tags
      const rawWithExif = await sharp({
        create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 120, b: 60 } },
      })
        .jpeg()
        .withMetadata({
          orientation: 6,
          exif: {
            IFD0: { Make: 'TestPhone', ImageDescription: 'Secret GPS Location' },
          },
        })
        .toBuffer();

      const beforeMeta = await sharp(rawWithExif).metadata();
      expect(beforeMeta.exif).toBeDefined();
      expect(beforeMeta.orientation).toBe(6);

      const manager = new UploadManager(tmp);
      const staged = await manager.stageImage('portrait.jpg', 'image/jpeg', rawWithExif);
      const resolved = await manager.resolveStagedFile(staged.stagedId);
      expect(resolved).not.toBeNull();

      const afterMeta = await sharp(resolved!.bytes).metadata();
      // EXIF stripped completely, and pixel dimensions rotated upright (20x40)
      expect(afterMeta.exif).toBeUndefined();
      expect(afterMeta.width).toBe(20);
      expect(afterMeta.height).toBe(40);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('strips ANSI codes and compacts passing run_checks output while preserving full failing output', async () => {
    const { formatCompactCheckSummary, stripAnsi } = await import('../src/verify.js');
    expect(stripAnsi('\u001b[32m✓ Completed\u001b[39m')).toBe('✓ Completed');

    const summary = formatCompactCheckSummary([
      {
        name: 'Production build',
        command: 'npm run build',
        passed: true,
        durationMs: 9500,
        output: [
          '\u001b[2m08:50:01\u001b[22m ▶ src/pages/poetry.astro',
          '\u001b[2m08:50:01\u001b[22m   └─ /poetry/index.html (+5ms)',
          '08:50:02 [build] 95 page(s) built in 6.21s',
          '  Indexed 89 pages',
        ].join('\n'),
      },
      {
        name: 'Verify (seo)',
        command: 'npm run verify:seo',
        passed: false,
        durationMs: 400,
        output: '\u001b[31mMissing meta description on /poetry\u001b[39m\nLine 2 detail',
      },
    ]);

    expect(summary).toContain('[PASS] Production build (9500ms) — 08:50:02 [build] 95 page(s) built in 6.21s · Indexed 89 pages');
    expect(summary).not.toContain('/poetry/index.html');
    expect(summary).toContain('[FAIL] Verify (seo) (400ms)\nMissing meta description on /poetry\nLine 2 detail');
  });

  it('serializes concurrent runAllVerificationChecks invocations via single-flight lock', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-verify-lock-'));
    try {
      const logFile = path.join(tmp, 'events.log');
      await fs.writeFile(
        path.join(tmp, '.halley.json'),
        JSON.stringify({
          checks: [
            {
              name: 'Overlap detector',
              command: `echo start >> ${logFile}; sleep 0.08; echo end >> ${logFile}`,
            },
          ],
        }),
      );
      const [r1, r2] = await Promise.all([
        runAllVerificationChecks(tmp),
        runAllVerificationChecks(tmp),
      ]);
      expect(r1.allPassed).toBe(true);
      expect(r2.allPassed).toBe(true);
      const lines = (await fs.readFile(logFile, 'utf8')).trim().split(/\r?\n/);
      expect(lines).toEqual(['start', 'end', 'start', 'end']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('auto-restarts AstroDevManager on unexpected exit, pauses/resumes cleanly, and marks crashed after budget exhausted', async () => {
    const procs: Array<EventEmitter & { exitCode: number | null; kill: () => boolean }> = [];
    const mgr = new AstroDevManager({
      repoRoot: '/tmp',
      sessionId: 'test-astro',
      astroPort: 4321,
      runnerPort: 4100,
      isReadOnly: () => false,
      onPatched: () => {},
      restartDelaysMs: [20, 20],
      crashWindowMs: 60_000,
      spawnAstro: () => {
        const fake = Object.assign(new EventEmitter(), {
          exitCode: null as number | null,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: () => {
            if (fake.exitCode === null) {
              fake.exitCode = 0;
              fake.emit('exit', 0, 'SIGTERM');
            }
            return true;
          },
        });
        procs.push(fake);
        return fake as unknown as ChildProcess;
      },
      probeReady: async () => true,
    });

    await mgr.start();
    expect(mgr.getStatus().ready).toBe(true);
    expect(mgr.getStatus().state).toBe('ready');
    expect(procs.length).toBe(1);

    await mgr.pause();
    expect(mgr.getStatus().state).toBe('paused');
    expect(mgr.getStatus().crashCount).toBe(0);
    await mgr.resume();
    expect(mgr.getStatus().state).toBe('ready');
    expect(procs.length).toBe(2);

    procs[1]!.exitCode = 137;
    procs[1]!.emit('exit', 137, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 60));
    expect(procs.length).toBe(3);
    expect(mgr.getStatus().state).toBe('ready');

    procs[2]!.exitCode = 137;
    procs[2]!.emit('exit', 137, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 60));
    expect(procs.length).toBe(4);

    procs[3]!.exitCode = 137;
    procs[3]!.emit('exit', 137, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 60));
    expect(mgr.getStatus().state).toBe('crashed');
    expect(procs.length).toBe(4);

    await mgr.stop();
  });

  it('configures claude-haiku-5-5 compaction below its 100K 5x tariff cliff and compacts in Pi Durable before crossing 100K', async () => {
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    const { createModels } = await import('@earendil-works/pi-ai/models');
    const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic');
    const { fauxAssistantMessage, fauxProvider } = await import('@earendil-works/pi-ai/providers/faux');
    const { CompactionEntry, createRegistry, Harness, MemoryStorage } = await import('@earendil-works/pi-durable');
    const { buildCompactionSettings } = await import('../src/pi-runtime.js');

    // 1. Validate thresholds against the real pi-ai Anthropic catalog
    const realCatalog = anthropicProvider().getModels();
    const settings = buildCompactionSettings(realCatalog);

    expect(settings.enabled).toBe(true);
    expect(settings.reserveTokens).toBe(20_000);
    expect(settings.keepRecentTokens).toBe(20_000);
    expect(settings.backgroundTokens).toBe(32_768);

    // claude-haiku-5-5 (1M window, 5x cliff > 100K): block at 80K, background at 64K, keep 16K
    const haiku55 = realCatalog.find((m) => m.id === 'claude-haiku-5-5')!;
    expect(haiku55.contextWindow).toBe(1_000_000);
    const haikuOverride = settings.modelOverrides['anthropic/claude-haiku-5-5']!;
    expect(haikuOverride).toEqual({
      reserveTokens: 920_000,
      keepRecentTokens: 16_000,
      backgroundTokens: 16_000,
    });
    const haikuBlocking = haiku55.contextWindow - haikuOverride.reserveTokens!;
    const haikuBackground = haikuBlocking - haikuOverride.backgroundTokens!;
    expect(haikuBlocking).toBe(80_000);
    expect(haikuBackground).toBe(64_000);

    // 1M flat-priced models (sonnet-5-5, opus-5-5): block at 800K, background at 700K, keep 60K
    expect(settings.modelOverrides['anthropic/claude-sonnet-5-5']).toEqual({
      reserveTokens: 200_000,
      keepRecentTokens: 60_000,
      backgroundTokens: 100_000,
    });
    expect(settings.modelOverrides['anthropic/claude-opus-5-5']).toEqual({
      reserveTokens: 200_000,
      keepRecentTokens: 60_000,
      backgroundTokens: 100_000,
    });

    // 200K models inherit base policy
    expect(settings.modelOverrides['anthropic/claude-haiku-4-5']).toBeUndefined();

    // 2. End-to-end Pi Durable Harness check: a 1M claude-haiku-5-5 session compacts above 80K (well below 100K & 1M)
    const faux = fauxProvider({
      provider: 'anthropic',
      models: [{ id: 'claude-haiku-5-5', contextWindow: 1_000_000, maxTokens: 128_000 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);

    let maxObservedPromptTokens = 0;
    faux.setResponses([
      () => fauxAssistantMessage('Turn 1 complete.'),
      () => fauxAssistantMessage('Turn 2 complete.'),
      // Summarization call triggered before Turn 3 runs (~85K > 80K blocking threshold)
      () =>
        fauxAssistantMessage(
          '## Goal\nEdit site\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] Turns 1-2\n\n### In Progress\n- [ ] Turn 3\n\n### Blocked\n- (none)\n\n## Key Decisions\n- None\n\n## Next Steps\n1. Finish Turn 3\n\n## Critical Context\n- (none)',
        ),
      (ctx) => {
        const approxPromptChars = ctx.messages
          .map((m) => JSON.stringify(m.content).length)
          .reduce((a, b) => a + b, 0);
        maxObservedPromptTokens = Math.max(maxObservedPromptTokens, Math.ceil(approxPromptChars / 4));
        return fauxAssistantMessage('Turn 3 complete after compaction.');
      },
    ]);

    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry: createRegistry(),
        settings: {
          compaction: buildCompactionSettings(faux.models),
        },
      },
      BACKGROUND_CONTEXT,
    );

    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: 'anthropic', modelId: 'claude-haiku-5-5' },
        },
      });
      harness.resume();

      // ~30K tokens each (105,000 chars / 3.5 estimate ~= 30K; / 4 faux ~= 26.25K)
      const chunk = 'a'.repeat(112_000);
      const sub1 = await root.submit({ type: 'input', requestId: 't1', content: chunk }, BACKGROUND_CONTEXT);
      expect((await sub1.wait(BACKGROUND_CONTEXT)).status).toBe('done');

      const sub2 = await root.submit({ type: 'input', requestId: 't2', content: chunk }, BACKGROUND_CONTEXT);
      expect((await sub2.wait(BACKGROUND_CONTEXT)).status).toBe('done');

      const sub3 = await root.submit({ type: 'input', requestId: 't3', content: chunk }, BACKGROUND_CONTEXT);
      expect((await sub3.wait(BACKGROUND_CONTEXT)).status).toBe('done');

      const watch = await root.watch(BACKGROUND_CONTEXT);
      const compactions = watch.value.entries.filter((e) => CompactionEntry.is(e));
      await watch.stop();

      expect(compactions.length).toBeGreaterThanOrEqual(1);
      // Turn 3 prompt after compaction must stay well under the 100,000-token tariff cliff
      expect(maxObservedPromptTokens).toBeGreaterThan(0);
      expect(maxObservedPromptTokens).toBeLessThan(100_000);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});


