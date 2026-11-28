import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './ast-classifier.js';
import type { AsyncFileLock } from './file-lock.js';
import { writeFileAtomic } from './serializer.js';

export interface UndoEntry {
  id: string;
  relFile: string;
  summary: string;
  beforeSource: string;
  afterSource: string;
  timestamp: number;
}

export type UndoRedoResult =
  | {
      ok: true;
      id: string;
      relFile: string;
      summary: string;
      canUndo: boolean;
      canRedo: boolean;
    }
  | {
      ok: false;
      code: 400 | 404 | 409;
      error: string;
      canUndo: boolean;
      canRedo: boolean;
    };

export class EditUndoStack {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private seq = 0;

  constructor(private maxEntries = 40) {}

  push(entry: Omit<UndoEntry, 'id' | 'timestamp'>): UndoEntry {
    // A newer edit to a file invalidates redo entries; an edit that changed nothing is not undoable.
    const full: UndoEntry = {
      ...entry,
      id: `edit-${++this.seq}-${Date.now()}`,
      timestamp: Date.now(),
    };
    if (entry.beforeSource === entry.afterSource) return full;
    this.undoStack.push(full);
    if (this.undoStack.length > this.maxEntries) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    return full;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  getStatus(): { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number } {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
    };
  }

  async undo(repoRoot: string, fileLock: AsyncFileLock): Promise<UndoRedoResult> {
    return this.apply('undo', repoRoot, fileLock);
  }

  async redo(repoRoot: string, fileLock: AsyncFileLock): Promise<UndoRedoResult> {
    return this.apply('redo', repoRoot, fileLock);
  }

  /**
   * Restores one entry. The file must still hold exactly the content this entry produced
   * (`afterSource` for undo, `beforeSource` for redo; compared by sha256): anything else means a
   * newer edit (agent, another tab, the user's editor) landed since, and restoring would clobber
   * it, so the entry is kept and 409 is returned. Writes go through the same atomic
   * temp → fsync → rename path as patches, under the per-file lock.
   */
  private async apply(
    direction: 'undo' | 'redo',
    repoRoot: string,
    fileLock: AsyncFileLock,
  ): Promise<UndoRedoResult> {
    const from = direction === 'undo' ? this.undoStack : this.redoStack;
    const to = direction === 'undo' ? this.redoStack : this.undoStack;
    const status = () => ({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
    const entry = from[from.length - 1];
    if (!entry) {
      return { ok: false, code: 404, error: direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo', ...status() };
    }

    const absPath = path.resolve(repoRoot, entry.relFile);
    if (!absPath.startsWith(path.resolve(repoRoot) + path.sep)) {
      return { ok: false, code: 400, error: 'Invalid file path', ...status() };
    }
    if (path.extname(absPath).toLowerCase() !== '.astro') {
      return { ok: false, code: 400, error: 'Only .astro files can be restored', ...status() };
    }

    const expected = direction === 'undo' ? entry.afterSource : entry.beforeSource;
    const restore = direction === 'undo' ? entry.beforeSource : entry.afterSource;

    return fileLock.withLock(entry.relFile, async (): Promise<UndoRedoResult> => {
      let current: string;
      try {
        current = await fs.readFile(absPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        return { ok: false, code: 404, error: `File not found: ${entry.relFile}`, ...status() };
      }

      if (sha256(current) !== sha256(expected)) {
        return {
          ok: false,
          code: 409,
          error:
            direction === 'undo'
              ? 'File was modified since this edit. Use Checkpoints to restore an earlier version.'
              : 'File was modified since undo. Redo is no longer valid.',
          ...status(),
        };
      }

      await writeFileAtomic(absPath, restore);

      from.pop();
      to.push(entry);

      return { ok: true, id: entry.id, relFile: entry.relFile, summary: entry.summary, ...status() };
    });
  }
}
