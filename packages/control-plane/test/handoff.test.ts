import { describe, expect, it } from 'vitest';
import {
  buildContinuationHandoffSummary,
  buildUndoHandoffSummary,
  extractTranscriptTurnDigest,
  stripInjectedPromptHeaders,
} from '../src/handoff.js';

describe('handoff digest & Undo context builders', () => {
  it('strips injected Halley prompt headers without losing user prose', () => {
    const raw = [
      '[Halley Page Request] {"pageRequestId":"req-1"}',
      '[Current Preview] route=/events viewport=desktop mode=browse',
      '[Selected Element 1] file=src/pages/events/index.astro loc=12:4 route=/events tag=<article> text="Joint Service"',
      '[Uploaded Image] stagedId=img-1 filename="flyer.jpg" mime=image/jpeg',
      '',
      'Please add Community Brunch and Christmas Celebration,',
      'and also add a Joint Service notice on the homepage.',
    ].join('\n');

    expect(stripInjectedPromptHeaders(raw)).toBe(
      'Please add Community Brunch and Christmas Celebration,\nand also add a Joint Service notice on the homepage.',
    );
  });

  it('pairs user prompts with final non-intermediate assistant replies and respects caps', () => {
    const transcriptJson = JSON.stringify({
      entries: [
        {
          role: 'user',
          text: '[Current Preview] route=/ viewport=desktop mode=browse\n\nAdd the Community Brunch and Joint Service.',
        },
        {
          role: 'assistant',
          isIntermediate: true,
          text: 'Let me check the events page first...',
        },
        {
          role: 'assistant',
          isIntermediate: false,
          text: 'I added Community Brunch, Christmas Celebration, and the Joint Service notice.',
        },
        {
          role: 'user',
          text: '[Current Preview] route=/ viewport=desktop mode=browse\n\nAlso fix the stray link on the homepage.',
        },
        {
          role: 'assistant',
          text: 'Removed the stray google.com link from the homepage intro.',
        },
      ],
    });

    const digest = extractTranscriptTurnDigest(transcriptJson);
    expect(digest.turns).toHaveLength(2);
    expect(digest.turns[0]?.user).toBe('Add the Community Brunch and Joint Service.');
    expect(digest.turns[0]?.assistant).toBe(
      'I added Community Brunch, Christmas Celebration, and the Joint Service notice.',
    );
    expect(digest.turns[1]?.user).toBe('Also fix the stray link on the homepage.');
    expect(digest.turns[1]?.assistant).toBe('Removed the stray google.com link from the homepage intro.');
    expect(digest.formatted).not.toContain('Let me check the events page first');
    expect(digest.formatted).not.toContain('[Current Preview]');
  });

  it('builds a continuation handoff with paired turns and omits staged uploads for published sessions', () => {
    const transcriptJson = JSON.stringify({
      entries: [
        {
          role: 'user',
          text: '[Current Preview] route=/events\n\nAdd Spring Retreat details.',
          attachments: [{ stagedId: 'st-1', filename: 'retreat.jpg' }],
        },
        { role: 'assistant', text: 'Added Spring Retreat to /events.' },
      ],
    });

    const publishedSummary = buildContinuationHandoffSummary(
      { title: 'Spring Retreat', status: 'published', pr_number: 42, owner_name: 'Sarah' },
      {
        sessionId: 's1',
        transcriptJson,
        handoffSummary: null,
        diffSummary: JSON.stringify([{ path: 'src/pages/events/index.astro', status: 'modified', additions: 14, deletions: 2 }]),
        mergedSha: 'abc1234',
        prUrl: 'https://github.com/o/r/pull/42',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    );

    expect(publishedSummary).toContain('This session continues "Spring Retreat" (published as PR #42, edited by Sarah).');
    expect(publishedSummary).toContain('src/pages/events/index.astro (modified, +14/-2)');
    expect(publishedSummary).toContain('- User: Add Spring Retreat details.');
    expect(publishedSummary).toContain('Halley: Added Spring Retreat to /events.');
    expect(publishedSummary).not.toContain('Staged uploads carried over');
  });

  it('builds an Undo handoff explaining inverted working-tree state, passive revertReason, file stats, and prior chat', () => {
    const summary = buildUndoHandoffSummary({
      baseBranch: 'main',
      targetTitle: 'test10',
      targetShas: ['318648242c35b6c3e6bba74a94c35a844c2d95bb'],
      revertReason: 'Joint service was cancelled',
      revertStatus: 'clean',
      revertCheckpointSha: 'ffd90781234567890',
      revertedCommits: [
        {
          sha: '318648242c35b6c3e6bba74a94c35a844c2d95bb',
          shortSha: '3186482',
          author: 'Sarah',
          date: '2026-11-25T17:13:06-08:00',
          subject: 'test10',
          body: '',
          files: [
            { path: 'src/pages/events/index.astro', status: 'modified', additions: 37, deletions: 1 },
            { path: 'src/pages/im-new/index.astro', status: 'modified', additions: 10, deletions: 0 },
          ],
        },
      ],
      srcSession: {
        title: 'test10',
        status: 'published',
        pr_number: 10,
        owner_name: 'Sarah',
      },
      srcArchive: {
        sessionId: 'parent-1',
        transcriptJson: JSON.stringify({
          entries: [
            {
              role: 'user',
              text: '[Current Preview] route=/events\n\nAdd Community Brunch, Christmas Celebration, and Joint Service.',
            },
            {
              role: 'assistant',
              text: 'I added all three events to the site.',
            },
          ],
        }),
        handoffSummary: null,
        diffSummary: '[]',
        mergedSha: '318648242c35b6c3e6bba74a94c35a844c2d95bb',
        prUrl: null,
        createdAt: '2026-11-25T00:00:00Z',
        updatedAt: '2026-11-25T00:00:00Z',
      },
    });

    expect(summary).toContain('UNDO DRAFT CONTEXT');
    expect(summary).toContain('ALREADY undone ALL changes from 3186482 in HEAD at checkpoint ffd9078');
    expect(summary).toContain('Partial-undo rule:');
    expect(summary).toContain('Joint service was cancelled');
    expect(summary).toContain('src/pages/events/index.astro (modified, +37/-1)');
    expect(summary).toContain('git show 3186482 -- <path>');
    expect(summary).toContain('User: Add Community Brunch, Christmas Celebration, and Joint Service.');
    expect(summary).toContain('Halley: I added all three events to the site.');
  });

  it('includes commit description fallback when undoing a standalone GitHub commit without a parent session', () => {
    const summary = buildUndoHandoffSummary({
      baseBranch: 'main',
      targetTitle: 'Update footer hours',
      targetShas: ['deadbeef1234567890'],
      revertReason: 'Reverting temporary hours',
      revertStatus: 'clean',
      revertedCommits: [
        {
          sha: 'deadbeef1234567890',
          shortSha: 'deadbee',
          author: 'Dev',
          date: '2026-11-25T10:00:00Z',
          subject: 'Update footer hours',
          body: 'Temporarily changed office hours for Thanksgiving week.',
          files: [{ path: 'src/data/site.ts', status: 'modified', additions: 2, deletions: 2 }],
        },
      ],
      srcSession: null,
      srcArchive: null,
    });

    expect(summary).toContain('Commit description: Temporarily changed office hours for Thanksgiving week.');
    expect(summary).toContain('src/data/site.ts (modified, +2/-2)');
  });
});
