import fs from 'node:fs/promises';
import path from 'node:path';
import type { AsyncFileLock } from './file-lock.js';

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
    const full: UndoEntry = {
      ...entry,
      id: `edit-${++this.seq}-${Date.now()}`,
      timestamp: Date.now(),
    };
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
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) {
      return {
        ok: false,
        code: 404,
        error: 'Nothing to undo',
        canUndo: false,
        canRedo: this.redoStack.length > 0,
      };
    }

    const absPath = path.resolve(repoRoot, entry.relFile);
    if (!absPath.startsWith(path.resolve(repoRoot) + path.sep)) {
      return {
        ok: false,
        code: 400,
        error: 'Invalid file path',
        canUndo: this.undoStack.length > 0,
        canRedo: this.redoStack.length > 0,
      };
    }

    return fileLock.withLock(entry.relFile, async () => {
      let current: string;
      try {
        current = await fs.readFile(absPath, 'utf8');
      } catch {
        return {
          ok: false,
          code: 404,
          error: `File not found: ${entry.relFile}`,
          canUndo: this.undoStack.length > 0,
          canRedo: this.redoStack.length > 0,
        };
      }

      if (current !== entry.afterSource) {
        return {
          ok: false,
          code: 409,
          error: 'File was modified externally since this edit. Use Checkpoints to restore an earlier version.',
          canUndo: this.undoStack.length > 0,
          canRedo: this.redoStack.length > 0,
        };
      }

      const tmpPath = `${absPath}.halley-tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmpPath, entry.beforeSource, 'utf8');
      await fs.rename(tmpPath, absPath);

      this.undoStack.pop();
      this.redoStack.push(entry);

      return {
        ok: true,
        id: entry.id,
        relFile: entry.relFile,
        summary: entry.summary,
        canUndo: this.undoStack.length > 0,
        canRedo: this.redoStack.length > 0,
      };
    });
  }

  async redo(repoRoot: string, fileLock: AsyncFileLock): Promise<UndoRedoResult> {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) {
      return {
        ok: false,
        code: 404,
        error: 'Nothing to redo',
        canUndo: this.undoStack.length > 0,
        canRedo: false,
      };
    }

    const absPath = path.resolve(repoRoot, entry.relFile);
    if (!absPath.startsWith(path.resolve(repoRoot) + path.sep)) {
      return {
        ok: false,
        code: 400,
        error: 'Invalid file path',
        canUndo: this.undoStack.length > 0,
        canRedo: this.redoStack.length > 0,
      };
    }

    return fileLock.withLock(entry.relFile, async () => {
      let current: string;
      try {
        current = await fs.readFile(absPath, 'utf8');
      } catch {
        return {
          ok: false,
          code: 404,
          error: `File not found: ${entry.relFile}`,
          canUndo: this.undoStack.length > 0,
          canRedo: this.redoStack.length > 0,
        };
      }

      if (current !== entry.beforeSource) {
        return {
          ok: false,
          code: 409,
          error: 'File was modified externally since undo. Redo is no longer valid.',
          canUndo: this.undoStack.length > 0,
          canRedo: this.redoStack.length > 0,
        };
      }

      const tmpPath = `${absPath}.halley-tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmpPath, entry.afterSource, 'utf8');
      await fs.rename(tmpPath, absPath);

      this.redoStack.pop();
      this.undoStack.push(entry);

      return {
        ok: true,
        id: entry.id,
        relFile: entry.relFile,
        summary: entry.summary,
        canUndo: this.undoStack.length > 0,
        canRedo: this.redoStack.length > 0,
      };
    });
  }
}
