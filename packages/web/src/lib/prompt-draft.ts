/**
 * Prompt-box send flow: the draft (text, chips, attachments) is kept until the send is
 * confirmed. On failure (dispatch resolves false or throws) nothing is cleared; on success only
 * what was actually sent is removed, so edits made while the send was in flight survive.
 */
export interface PromptDraft<C, A> {
  input: string;
  chips: C[];
  attachments: A[];
}

type Updater<T> = (fn: (prev: T) => T) => void;

export async function sendPromptDraft<C, A>(opts: {
  draft: PromptDraft<C, A>;
  /** Text to send instead of `draft.input` (the input box is then left alone). */
  overrideText?: string;
  chipKey: (c: C) => string;
  attachmentKey: (a: A) => string;
  /** Sends the trimmed text (may be empty when only chips/attachments are attached). */
  dispatch: (text: string) => Promise<boolean>;
  setInput: Updater<string>;
  setChips: Updater<C[]>;
  setAttachments: Updater<A[]>;
}): Promise<boolean> {
  const { draft, overrideText } = opts;
  const textToSend = (overrideText ?? draft.input).trim();
  if (!textToSend && draft.attachments.length === 0 && draft.chips.length === 0) return false;
  const sentInput = draft.input;
  const sentChipKeys = new Set(draft.chips.map(opts.chipKey));
  const sentAttachmentIds = new Set(draft.attachments.map(opts.attachmentKey));
  const ok = await opts.dispatch(textToSend);
  if (!ok) return false; // draft untouched; the dispatcher already surfaced the error
  if (overrideText === undefined) opts.setInput((prev) => (prev === sentInput ? '' : prev));
  opts.setChips((prev) => prev.filter((c) => !sentChipKeys.has(opts.chipKey(c))));
  opts.setAttachments((prev) => prev.filter((a) => !sentAttachmentIds.has(opts.attachmentKey(a))));
  return true;
}
