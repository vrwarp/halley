import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@astrojs/compiler';
import type { PageSectionOptionDto, SiteRouteEntryDto } from '@halley/shared';

export type SiteRouteEntry = SiteRouteEntryDto;

export interface SiteStructureDiscovery {
  routes: SiteRouteEntry[];
  sections: PageSectionOptionDto[];
  dynamicPatterns: string[];
  generatedRoutes: string[];
}

const PAGE_EXTS = new Set(['.astro', '.md', '.mdx']);

interface AstAttr {
  type: string;
  name?: string;
  kind?: string;
  value?: string;
}

interface AstNode {
  type: string;
  name?: string;
  value?: string;
  attributes?: AstAttr[];
  children?: AstNode[];
}

function hasNoindexInAst(node: AstNode): boolean {
  if (node.type === 'component' || node.type === 'element') {
    const attrs = node.attributes ?? [];
    for (const a of attrs) {
      if (a.name === 'indexable') {
        const v = (a.value ?? '').trim();
        if (v === 'false' || v === "'false'" || v === '"false"') {
          return true;
        }
      }
    }
    if (node.type === 'element' && node.name?.toLowerCase() === 'meta') {
      const nameAttr = attrs.find((a) => a.name?.toLowerCase() === 'name')?.value?.toLowerCase();
      const contentAttr = attrs.find((a) => a.name?.toLowerCase() === 'content')?.value?.toLowerCase() ?? '';
      if (nameAttr === 'robots' && contentAttr.includes('noindex')) {
        return true;
      }
    }
  }
  for (const child of node.children ?? []) {
    if (hasNoindexInAst(child)) return true;
  }
  return false;
}

export async function isPageSourceUnlisted(src: string, ext: string): Promise<boolean> {
  if (ext === '.astro') {
    try {
      const parsed = await parse(src, { position: false });
      return hasNoindexInAst(parsed.ast as AstNode);
    } catch {
      // Fallback to conservative attribute/meta check if AST parse fails
      return /\bindexable\s*=\s*\{\s*false\s*\}|<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(
        src,
      );
    }
  }
  // Markdown/MDX frontmatter
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    return /\bindexable\s*:\s*false\b|\bnoindex\s*:\s*true\b/i.test(fm[1]!);
  }
  return false;
}

function sectionFromRoute(route: string, isIndexFile: boolean): string {
  if (route === '/') return '/';
  if (isIndexFile) return route;
  const idx = route.lastIndexOf('/');
  return idx <= 0 ? '/' : route.slice(0, idx);
}

function formatSectionLabel(section: string): string {
  if (section === '/') return 'Top level (/)';
  const seg = section.split('/').filter(Boolean).pop() ?? section;
  const titled = seg
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `${titled} (${section})`;
}

async function walkPages(
  dir: string,
  pagesRoot: string,
  repoRoot: string,
  routes: SiteRouteEntry[],
  dynamicPatterns: string[],
  sectionDirs: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const relDir = path.relative(pagesRoot, full).split(path.sep).join('/');
      if (!relDir.includes('[')) {
        sectionDirs.add('/' + relDir);
      }
      await walkPages(full, pagesRoot, repoRoot, routes, dynamicPatterns, sectionDirs);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!PAGE_EXTS.has(ext)) continue;
    if (entry.name === '404.astro' || entry.name === '500.astro') continue;

    const rel = path.relative(pagesRoot, full).split(path.sep).join('/');
    const fileRel = path.relative(repoRoot, full).split(path.sep).join('/');
    let route = '/' + rel.slice(0, -ext.length);
    let isIndexFile = false;
    if (route === '/index') {
      route = '/';
      isIndexFile = true;
    } else if (route.endsWith('/index')) {
      route = route.slice(0, -'/index'.length) || '/';
      isIndexFile = true;
    }

    if (rel.includes('[')) {
      dynamicPatterns.push(route);
      continue;
    }

    let unlisted = false;
    let mtimeMs: number | undefined;
    try {
      const [src, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      unlisted = await isPageSourceUnlisted(src, ext);
      mtimeMs = stat.mtimeMs;
    } catch {
      // ignore
    }

    routes.push({
      route,
      label: route === '/' ? 'Home (/)' : route,
      file: fileRel,
      section: sectionFromRoute(route, isIndexFile),
      unlisted,
      mtimeMs,
    });
  }
}

async function discoverGeneratedContentRoutes(
  repoRoot: string,
  dynamicPatterns: string[],
): Promise<string[]> {
  const generated: string[] = [];
  const contentRoot = path.join(repoRoot, 'src', 'content');
  for (const pattern of dynamicPatterns) {
    // Match single-param patterns like /sermons/[slug] or /blog/[id]
    const m = pattern.match(/^\/([a-z0-9/_-]+)\/\[[^.\]]+\]$/i);
    if (!m) continue;
    const prefix = m[1]!;
    const collectionDir = path.join(contentRoot, prefix);
    try {
      const files = await fs.readdir(collectionDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        const ext = path.extname(f.name);
        if (!['.json', '.md', '.mdx', '.yaml', '.yml'].includes(ext)) continue;
        const slug = f.name.slice(0, -ext.length);
        generated.push(`/${prefix}/${slug}`);
      }
    } catch {
      // collection directory doesn't match route prefix — ignore
    }
  }
  generated.sort();
  return generated;
}

export async function discoverSiteRoutes(repoRoot: string): Promise<SiteRouteEntry[]> {
  const { routes } = await discoverSiteStructure(repoRoot);
  return routes;
}

export async function discoverSiteStructure(repoRoot: string): Promise<SiteStructureDiscovery> {
  const pagesRoot = path.join(repoRoot, 'src', 'pages');
  const routes: SiteRouteEntry[] = [];
  const dynamicPatterns: string[] = [];
  const sectionDirs = new Set<string>(['/']);

  await walkPages(pagesRoot, pagesRoot, repoRoot, routes, dynamicPatterns, sectionDirs);
  routes.sort((a, b) => a.route.localeCompare(b.route));
  dynamicPatterns.sort();

  const generatedRoutes = await discoverGeneratedContentRoutes(repoRoot, dynamicPatterns);

  const sections: PageSectionOptionDto[] = Array.from(sectionDirs)
    .sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)))
    .map((sec) => {
      // Pick most recently modified non-index .astro sibling in this section as defaultStyleRoute
      const inSec = routes.filter((r) => r.section === sec && r.file?.endsWith('.astro'));
      const nonIndex = inSec.filter((r) => r.route !== sec);
      const candidates = nonIndex.length > 0 ? nonIndex : inSec;
      candidates.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
      return {
        section: sec,
        label: formatSectionLabel(sec),
        defaultStyleRoute: candidates[0]?.route,
      };
    });

  return { routes, sections, dynamicPatterns, generatedRoutes };
}
