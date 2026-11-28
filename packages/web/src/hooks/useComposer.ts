import type { ElementContext, PreviewMode, StagedAttachment } from '@halley/shared';
import { elementKey, friendlyElementKind } from '@halley/shared';
import { useRef, useState } from 'react';
import { api } from '../api.js';
import { sendPromptDraft } from '../lib/prompt-draft.js';

/** Chips are unique per element + highlighted phrase. */
export const chipKeyOf = (c: ElementContext) => `${elementKey(c)}|${c.selectedText ?? ''}`;
export const chipLabelOf = (c: ElementContext, persona: 'non-technical' | 'developer' = 'non-technical') => {
  if (c.selectedText) return `“${c.selectedText}”`;
  const kind = persona === 'developer' ? `<${c.tagName}>` : friendlyElementKind(c.tagName);
  return c.renderedText ? `${kind}: ${c.renderedText}` : kind;
};

export interface UseComposerOptions {
  sessionId: string;
  canEdit: boolean;
  editorContext: { currentRoute: string; viewport: 'desktop' | 'tablet' | 'mobile'; mode: PreviewMode };
  /** Delivers a client message; resolves true once accepted (socket or HTTP fallback). */
  dispatch: (payload: Record<string, unknown>) => Promise<boolean>;
}

/** The chat composer draft: text, attached element chips, staged image uploads and sending. */
export function useComposer({ sessionId, canEdit, editorContext, dispatch }: UseComposerOptions) {
  const [input, setInput] = useState('');
  const [chips, setChips] = useState<ElementContext[]>([]);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const sendingPromptRef = useRef(false);

  /** Attaches an element chip unless an identical one (same element + phrase) is attached already. */
  const addChip = (ctx: ElementContext) => {
    const key = chipKeyOf(ctx);
    setChips((prev) => (prev.some((c) => chipKeyOf(c) === key) ? prev : [...prev, ctx]));
  };

  /** Keeps the draft (text, chips, attachments) until the send is confirmed; resolves to success. */
  const sendPrompt = async (whenBusy?: 'steer' | 'followUp', overrideText?: string): Promise<boolean> => {
    if (!canEdit || sendingPromptRef.current) return false;
    const defaultEmptyPrompt =
      attachments.length > 0 && chips.length === 0
        ? 'Please use the attached photo.'
        : chips.length === 1
          ? 'What is this section on the page and how could I update or improve it?'
          : 'How could I update or improve these selected sections?';
    return sendPromptDraft({
      draft: { input, chips, attachments },
      overrideText,
      chipKey: chipKeyOf,
      attachmentKey: (a) => a.stagedId,
      setInput,
      setChips,
      setAttachments,
      dispatch: async (textToSend) => {
        sendingPromptRef.current = true;
        setSendingPrompt(true);
        try {
          return await dispatch({
            type: 'submit_input',
            requestId: crypto.randomUUID(),
            text: textToSend || defaultEmptyPrompt,
            contextChips: chips,
            attachments,
            editorContext: {
              currentRoute: editorContext.currentRoute,
              viewport: editorContext.viewport,
              mode: editorContext.mode,
            },
            whenBusy,
          });
        } finally {
          sendingPromptRef.current = false;
          setSendingPrompt(false);
        }
      },
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !canEdit) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        const att = await api.uploadImage(sessionId, file);
        setAttachments((prev) => [...prev, att]);
      }
    } finally {
      setUploading(false);
    }
  };

  return {
    input,
    setInput,
    chips,
    setChips,
    addChip,
    attachments,
    setAttachments,
    uploading,
    dragOver,
    setDragOver,
    sendingPrompt,
    sendPrompt,
    handleFiles,
  };
}
