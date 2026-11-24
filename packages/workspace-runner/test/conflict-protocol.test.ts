import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createCheckpoint, resetToRef, startRevertCommits } from '../src/checkpoints-and-git.js';
import {
  buildContradictionRecord,
  mergeJsonThreeWay,
  tryDeterministicResolve,
  validateResolvedContent,
  type ConflictEvidencePack,
} from '../src/conflict-protocol.js';
import { computeJsonFieldDiff, computeWordDiff } from '../src/visual-diff.js';

const execFileAsync = promisify(execFile);

const identity = {
  botName: 'Halley Bot',
  botEmail: 'halley-bot@users.noreply.github.com',
  editorName: 'Grace',
  editorEmail: 'grace@thecrossing.website',
};

function mkPack(overrides: Partial<ConflictEvidencePack>): ConflictEvidencePack {
  return {
    path: 'src/pages/index.astro',
    affectedRoute: '/',
    fileType: 'astro',
    baseContent: '<h1>Welcome</h1>\n',
    oursContent: '<h1>Welcome</h1>\n',
    theirsContent: '<h1>Welcome</h1>\n',
    isBinary: false,
    upstreamCommits: [
      { sha: 'abc1234', shortSha: 'abc1234', author: 'Grace', date: '2026-11-21T10:00:00Z', subject: 'Update Easter headline' },
    ],
    localCheckpoints: ['Update homepage hero'],
    ...overrides,
  };
}

describe('P1 Conflict Resolution Protocol taxonomy fixtures', () => {
  it('auto-resolves derived lockfiles (derived_file)', () => {
    const rec = tryDeterministicResolve(
      mkPack({
        path: 'package-lock.json',
        fileType: 'json',
        oursContent: '{"lockfileVersion":3,"a":1}',
        theirsContent: '{"lockfileVersion":3,"a":2}',
      }),
    );
    expect(rec?.category).toBe('derived_file');
    expect(rec?.status).toBe('auto_resolved');
    expect(rec?.resolvedContent).toContain('"a":2');
  });

  it('auto-resolves identical intent edits', () => {
    const rec = tryDeterministicResolve(
      mkPack({
        oursContent: '<p>Sundays at 10:30 AM</p>\n',
        theirsContent: '<p>Sundays at 10:30 AM</p>\n',
      }),
    );
    expect(rec?.category).toBe('identical_intent');
    expect(rec?.status).toBe('auto_resolved');
  });

  it('auto-resolves formatting vs content edits', () => {
    const rec = tryDeterministicResolve(
      mkPack({
        baseContent: '<h1>Welcome   Home</h1>',
        theirsContent: '<h1>Welcome Home</h1>', // whitespace-only reformat
        oursContent: '<h1>Welcome to The Crossing</h1>',
      }),
    );
    expect(rec?.category).toBe('formatting_vs_content');
    expect(rec?.status).toBe('auto_resolved');
    expect(rec?.resolvedContent).toBe('<h1>Welcome to The Crossing</h1>');
  });

  it('structurally merges sermon JSON collections when both sides add episodes (both_added) or edit disjoint fields', () => {
    const base = {
      title: 'Gospel of Mark',
      dateRange: '2026',
      episodes: [{ title: 'Week 1', date: '2026-01-04', youtubeId: 'aaa' }],
    };
    const ours = {
      ...base,
      dateRange: 'Jan–Mar 2026',
      episodes: [...base.episodes, { title: 'Week 2', date: '2026-01-11', youtubeId: 'bbb' }],
    };
    const theirs = {
      ...base,
      episodes: [...base.episodes, { title: 'Week 3', date: '2026-01-18', youtubeId: 'ccc' }],
    };

    const merged = mergeJsonThreeWay(base, ours, theirs);
    expect(merged.conflicts).toEqual([]);
    expect(merged.category).toBe('both_added');
    const out = merged.merged as typeof base;
    expect(out.dateRange).toBe('Jan–Mar 2026');
    expect(out.episodes.map((e) => e.title)).toEqual(['Week 1', 'Week 2', 'Week 3']);

    const rec = tryDeterministicResolve(
      mkPack({
        path: 'src/content/sermons/mark.json',
        fileType: 'json',
        baseContent: JSON.stringify(base),
        oursContent: JSON.stringify(ours),
        theirsContent: JSON.stringify(theirs),
      }),
    );
    expect(rec?.status).toBe('auto_resolved');
    expect(rec?.category).toBe('both_added');
  });

  it('asks user with 2 options for binary_contradiction and delete_vs_modify', () => {
    const bin = tryDeterministicResolve(
      mkPack({
        path: 'public/images/community/youth.webp',
        fileType: 'binary',
        isBinary: true,
      }),
    );
    expect(bin?.category).toBe('binary_contradiction');
    expect(bin?.status).toBe('needs_choice');
    expect(bin?.options?.length).toBe(2);

    const del = tryDeterministicResolve(
      mkPack({
        oursContent: '<h1>Summer Camp 2026</h1>',
        theirsContent: null,
      }),
    );
    expect(del?.category).toBe('delete_vs_modify');
    expect(del?.status).toBe('needs_choice');
    expect(del?.options?.length).toBe(2);
  });

  it('builds at most 3 options with recommended first for true_contradiction', () => {
    const rec = buildContradictionRecord(
      mkPack({
        oursContent: '<h1>Spring Celebration</h1>',
        theirsContent: '<h1>Easter at The Crossing</h1>',
      }),
      {
        combinedContent: '<h1>Easter & Spring Celebration at The Crossing</h1>',
        recommended: 'combined',
      },
    );
    expect(rec.category).toBe('true_contradiction');
    expect(rec.options?.length).toBe(3);
    expect(rec.options?.[0]?.id).toBe('combined');
    expect(rec.options?.[0]?.recommended).toBe(true);
  });

  it('hard-validates against leftover conflict markers, invalid JSON, and unclosed Astro frontmatter', async () => {
    expect(
      (await validateResolvedContent('/tmp', 'a.astro', '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main')).valid,
    ).toBe(false);
    expect((await validateResolvedContent('/tmp', 'a.json', '{bad json')).valid).toBe(false);
    expect((await validateResolvedContent('/tmp', 'a.astro', '---\nconst x = 1;\n<p>hi</p>')).valid).toBe(false);
    expect((await validateResolvedContent('/tmp', 'a.astro', '---\nconst x = 1;\n---\n<p>hi</p>')).valid).toBe(true);
  });
});

describe('P3 visual diff helpers & P5 revert/reset git helpers', () => {
  it('computes word-level diff and JSON field diff cleanly', () => {
    const wd = computeWordDiff('Spring Celebration at 10am', 'Easter Celebration at 10:30am');
    expect(wd.some((t) => t.type === 'del' && t.value.includes('Spring'))).toBe(true);
    expect(wd.some((t) => t.type === 'add' && t.value.includes('Easter'))).toBe(true);

    const jf = computeJsonFieldDiff(
      JSON.stringify({ title: 'Old Series', book: 'Mark' }),
      JSON.stringify({ title: 'New Series', book: 'Mark' }),
    );
    expect(jf).toEqual([{ field: 'title', before: 'Old Series', after: 'New Series' }]);
  });

  it('reverts a published commit cleanly ($0 AI) and supports resetToRef undo', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-revert-test-'));
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });

      await fs.writeFile(path.join(tmp, 'banner.txt'), 'Original banner\n');
      await execFileAsync('git', ['add', '-A'], { cwd: tmp });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmp });

      await fs.writeFile(path.join(tmp, 'banner.txt'), 'Wrong Easter date\n');
      const badCkpt = await createCheckpoint(tmp, 'Easter banner', identity);
      expect(badCkpt).not.toBeNull();
      const beforeRevertSha = badCkpt!.sha;

      const rev = await startRevertCommits(tmp, [badCkpt!.sha], identity);
      expect(rev.status).toBe('clean');
      expect(await fs.readFile(path.join(tmp, 'banner.txt'), 'utf8')).toBe('Original banner\n');

      // Single-step resetToRef restores pre-revert snapshot
      expect(await resetToRef(tmp, beforeRevertSha)).toBe(true);
      expect(await fs.readFile(path.join(tmp, 'banner.txt'), 'utf8')).toBe('Wrong Easter date\n');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
