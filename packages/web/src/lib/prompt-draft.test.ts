import { describe, expect, it } from 'vitest';
import { sendPromptDraft, type PromptDraft } from './prompt-draft.js';

type Chip = { id: string };
type Att = { stagedId: string };

/** Minimal state holder mimicking React's functional setState. */
function harness(initial: PromptDraft<Chip, Att>) {
  const state = { ...initial };
  return {
    state,
    setInput: (fn: (p: string) => string) => void (state.input = fn(state.input)),
    setChips: (fn: (p: Chip[]) => Chip[]) => void (state.chips = fn(state.chips)),
    setAttachments: (fn: (p: Att[]) => Att[]) => void (state.attachments = fn(state.attachments)),
  };
}

const keys = { chipKey: (c: Chip) => c.id, attachmentKey: (a: Att) => a.stagedId };
const draft = (): PromptDraft<Chip, Att> => ({
  input: '  Make the title bigger  ',
  chips: [{ id: 'hero' }],
  attachments: [{ stagedId: 'img1' }],
});

describe('sendPromptDraft', () => {
  it('keeps the whole draft when the send fails', async () => {
    const h = harness(draft());
    const sent: string[] = [];
    const ok = await sendPromptDraft({
      ...keys,
      ...h,
      draft: draft(),
      dispatch: async (t) => {
        sent.push(t);
        return false;
      },
    });
    expect(ok).toBe(false);
    expect(sent).toEqual(['Make the title bigger']);
    expect(h.state).toEqual(draft());
  });

  it('keeps the draft when dispatch throws (and propagates the error)', async () => {
    const h = harness(draft());
    await expect(
      sendPromptDraft({
        ...keys,
        ...h,
        draft: draft(),
        dispatch: async () => {
          throw new Error('socket closed');
        },
      }),
    ).rejects.toThrow('socket closed');
    expect(h.state).toEqual(draft());
  });

  it('clears only what was sent; edits made while in flight survive', async () => {
    const h = harness(draft());
    const ok = await sendPromptDraft({
      ...keys,
      ...h,
      draft: draft(),
      dispatch: async () => {
        // User keeps working while the send is in flight.
        h.state.chips = [...h.state.chips, { id: 'footer' }];
        h.state.attachments = [...h.state.attachments, { stagedId: 'img2' }];
        return true;
      },
    });
    expect(ok).toBe(true);
    expect(h.state).toEqual({ input: '', chips: [{ id: 'footer' }], attachments: [{ stagedId: 'img2' }] });
  });

  it('does not clear input typed during the send', async () => {
    const h = harness(draft());
    await sendPromptDraft({
      ...keys,
      ...h,
      draft: draft(),
      dispatch: async () => {
        h.state.input = 'next question';
        return true;
      },
    });
    expect(h.state.input).toBe('next question');
  });

  it('overrideText leaves the input box alone; empty drafts are not sent', async () => {
    const h = harness(draft());
    const sent: string[] = [];
    const dispatch = async (t: string) => (sent.push(t), true);
    expect(await sendPromptDraft({ ...keys, ...h, draft: draft(), overrideText: 'Yes', dispatch })).toBe(true);
    expect(h.state.input).toBe(draft().input);
    expect(
      await sendPromptDraft({ ...keys, ...h, draft: { input: '   ', chips: [], attachments: [] }, dispatch }),
    ).toBe(false);
    expect(sent).toEqual(['Yes']);
  });
});
