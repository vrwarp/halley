import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ignoreMissingPath, isMissingPathError } from './diagnostics.js';
import { normalizeHref, writeFileAtomic } from './serializer.js';

export interface SiteImageEntry {
  /** Public root-relative path, e.g. `/images/community/youth.webp`. */
  path: string;
  /** Folder label under `public/`, e.g. `images/community`. */
  folder: string;
  filename: string;
  sizeBytes: number;
}

const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.avif']);

async function walkImages(
  dir: string,
  publicRoot: string,
  out: SiteImageEntry[],
  maxCount: number,
): Promise<void> {
  if (out.length >= maxCount) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A missing images folder simply has no images; anything else is worth a warning.
    ignoreMissingPath(`listing images in ${dir}`, err);
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxCount) return;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkImages(full, publicRoot, out, maxCount);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    let sizeBytes = 0;
    try {
      const st = await fs.stat(full);
      sizeBytes = st.size;
    } catch (err) {
      // Removed between readdir and stat: list it with an unknown (0) size.
      ignoreMissingPath(`reading size of ${full}`, err);
    }
    const rel = path.relative(publicRoot, full).split(path.sep).join('/');
    const folder = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    out.push({
      path: `/${rel}`,
      folder,
      filename: entry.name,
      sizeBytes,
    });
  }
}

export async function listSiteImages(repoRoot: string, maxCount = 300): Promise<SiteImageEntry[]> {
  const publicRoot = path.join(repoRoot, 'public');
  const out: SiteImageEntry[] = [];
  await walkImages(path.join(publicRoot, 'images'), publicRoot, out, maxCount);

  // Also include top-level public/* images (like favicon/og images) if not already found
  try {
    const topEntries = await fs.readdir(publicRoot, { withFileTypes: true });
    for (const entry of topEntries) {
      if (out.length >= maxCount) break;
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      const p = `/${entry.name}`;
      if (out.some((item) => item.path === p)) continue;
      let sizeBytes = 0;
      try {
        sizeBytes = (await fs.stat(path.join(publicRoot, entry.name))).size;
      } catch (err) {
        ignoreMissingPath(`reading size of public/${entry.name}`, err);
      }
      out.push({ path: p, folder: '', filename: entry.name, sizeBytes });
    }
  } catch (err) {
    // public/ may not exist yet
    ignoreMissingPath('listing public/', err);
  }

  out.sort((a, b) => a.folder.localeCompare(b.folder) || a.filename.localeCompare(b.filename));
  return out;
}

export function resolveImageTargetRelDir(
  existingSrc: string | undefined,
  previewBase: string,
  originalBase: string,
): string {
  if (existingSrc) {
    const norm = normalizeHref(existingSrc, previewBase, originalBase);
    if (norm.kind === 'internal' && norm.value.startsWith('/images/')) {
      const dir = path.posix.dirname(norm.value).replace(/^\/+/, '');
      if (dir && dir.startsWith('images') && !dir.includes('..')) {
        return path.posix.join('public', dir);
      }
    }
  }
  return 'public/images/uploads';
}

function slugifyFilenameBase(filename: string): string {
  const ext = path.extname(filename);
  const rawBase = path.basename(filename, ext).toLowerCase();
  const slug = rawBase
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'image';
}

export interface WriteSiteImageInput {
  repoRoot: string;
  filename: string;
  bytes: Buffer;
  existingSrc?: string;
  previewBase: string;
  originalBase: string;
  /** Optional converter (e.g., sharp -> WebP) injected by workspace-runner. */
  convertImage?: (bytes: Buffer, ext: string) => Promise<{ bytes: Buffer; ext: string } | null>;
}

export interface WriteSiteImageResult {
  publicPath: string;
  diskRelPath: string;
  sizeBytes: number;
}

export async function writeSiteImage(input: WriteSiteImageInput): Promise<WriteSiteImageResult> {
  const relDir = resolveImageTargetRelDir(input.existingSrc, input.previewBase, input.originalBase);
  const absDir = path.resolve(input.repoRoot, relDir);
  const absPublic = path.resolve(input.repoRoot, 'public');
  if (!absDir.startsWith(absPublic + path.sep) && absDir !== absPublic) {
    throw new Error('Target image directory must be inside public/');
  }

  await fs.mkdir(absDir, { recursive: true });

  const rawExt = path.extname(input.filename).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.webp';
  let finalBytes = input.bytes;
  let finalExt = IMAGE_EXTS.has(rawExt) ? rawExt : '.webp';

  if (input.convertImage && rawExt !== '.svg' && rawExt !== '.gif') {
    const converted = await input.convertImage(input.bytes, rawExt);
    if (converted) {
      finalBytes = converted.bytes;
      finalExt = converted.ext;
    }
  }

  const baseSlug = slugifyFilenameBase(input.filename);
  let candidateName = `${baseSlug}${finalExt}`;
  let absDest = path.join(absDir, candidateName);

  // Never overwrite an existing image file (protects references on other pages)
  let exists = true;
  try {
    await fs.access(absDest);
  } catch (err) {
    if (!isMissingPathError(err)) throw err;
    exists = false;
  }
  if (exists) {
    const suffix = crypto.randomBytes(3).toString('hex');
    candidateName = `${baseSlug}-${suffix}${finalExt}`;
    absDest = path.join(absDir, candidateName);
  }

  await writeFileAtomic(absDest, finalBytes);

  const relFromPublic = path.relative(absPublic, absDest).split(path.sep).join('/');
  const diskRelPath = path.relative(path.resolve(input.repoRoot), absDest).split(path.sep).join('/');

  return {
    publicPath: `/${relFromPublic}`,
    diskRelPath,
    sizeBytes: finalBytes.length,
  };
}
