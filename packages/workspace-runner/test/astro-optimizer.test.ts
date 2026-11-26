import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  buildOptimizationPrompt,
  runDeterministicOptimizationPrePass,
  scanBareGitRepo,
} from '../src/astro-optimizer.js';

const execFileAsync = promisify(execFile);

async function createRepoWithFiles(
  files: Record<string, string | Buffer>,
): Promise<{ workDir: string; bareDir: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-astro-opt-'));
  const workDir = path.join(root, 'work');
  const bareDir = path.join(root, 'mirror.git');
  await fs.mkdir(workDir, { recursive: true });

  await execFileAsync('git', ['init', '-b', 'main'], { cwd: workDir });
  await execFileAsync('git', ['config', 'user.name', 'Test Admin'], { cwd: workDir });
  await execFileAsync('git', ['config', 'user.email', 'admin@example.com'], { cwd: workDir });

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(workDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  await execFileAsync('git', ['add', '-A'], { cwd: workDir });
  await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: workDir });
  await execFileAsync('git', ['clone', '--bare', workDir, bareDir]);

  return {
    workDir,
    bareDir,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function generateLargeNoisyPng(): Promise<Buffer> {
  // 420x420 RGB random noise produces an uncompressible >350 KB PNG that compresses well to WebP
  const width = 420;
  const height = 420;
  const raw = crypto.randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

describe('astro-optimizer static AST & git-mirror audit + $0 pre-pass', () => {
  it('scores a clean Halley-friendly Astro repo >= 95 with 0 penalty for Content Collections', async () => {
    const { bareDir, cleanup } = await createRepoWithFiles({
      '.gitignore': 'node_modules/\ndist/\n.astro/\n',
      'package.json': JSON.stringify({
        name: 'clean-church-site',
        scripts: {
          dev: 'astro dev',
          build: 'astro build',
          check: 'astro check',
          'verify:seo': 'node scripts/verify-seo.mjs',
        },
      }),
      'astro.config.mjs': `import { defineConfig } from 'astro/config';\nexport default defineConfig({ site: 'https://example.org', base: '/thecrossing.website' });\n`,
      'AGENTS.md': `# AGENTS.md\nAlways use \`url('/path')\` for internal links and \`public/\` assets under \`base: '/thecrossing.website'\`.\n`,
      'src/content.config.ts': `import { defineCollection, z } from 'astro:content';\nexport const collections = { sermons: defineCollection({ schema: z.object({ title: z.string() }) }) };\n`,
      'src/content/sermons/ep-1.json': JSON.stringify({ title: 'Grace & Peace' }),
      'src/content/sermons/ep-2.json': JSON.stringify({ title: 'Living Hope' }),
      'src/pages/index.astro': `---
import { getCollection } from 'astro:content';
const sermons = await getCollection('sermons');
const serviceTime = 'Sundays at 10:30 AM';
---
<main>
  <h1>Welcome to <em>The Crossing</em></h1>
  <p>A multiethnic church family in Hayward.</p>
  <p>{serviceTime}</p>
  <ul>
    {sermons.map((s) => <li>{s.data.title}</li>)}
  </ul>
</main>
`,
      '.github/workflows/ci.yml': `name: CI\non:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`,
      '.github/workflows/deploy.yml': `name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: 'npm'\n      - run: npm ci && npm run build\n      - uses: actions/upload-pages-artifact@v3\n      - uses: actions/deploy-pages@v4\n`,
    });

    try {
      const { report } = await scanBareGitRepo(bareDir, {
        repoSlug: 'vrwarp/clean-site',
        baseBranch: 'main',
      });

      expect(report.score).toBe(100);
      expect(report.findings).toHaveLength(0);
      expect(report.metrics.avoidableLockedElements).toBe(0);
      expect(report.metrics.inlineEditableElements).toBe(2);
      expect(report.metrics.intentionalDynamicElements).toBe(2);
      expect(report.metrics.inlineEditablePct).toBe(50);
    } finally {
      await cleanup();
    }
  });

  it('detects all 5 pillars of anti-patterns while excluding favicons, OG cards, and dynamic image dirs', async () => {
    const bigPng = await generateLargeNoisyPng();
    expect(bigPng.length).toBeGreaterThan(300 * 1024);

    const monolithicJson = JSON.stringify(
      Array.from({ length: 240 }, (_, i) => ({
        id: `item-${i}`,
        title: `Archived Sermon Series ${i}`,
        description: 'Long historical description text repeated for testing monolithic JSON detection.',
      })),
      null,
      2,
    );
    expect(Buffer.byteLength(monolithicJson)).toBeGreaterThan(16 * 1024);

    const { bareDir, cleanup } = await createRepoWithFiles({
      '.gitignore': 'node_modules/\n',
      'package.json': JSON.stringify({
        name: 'unoptimized-site',
        scripts: { dev: 'astro dev', build: 'astro build' },
      }),
      'astro.config.mjs': `export default { base: '/subpath' };\n`,
      'AGENTS.md': `# Style Guide\nUse warm stone colors.\n`,
      'src/content/posts/welcome.md': `---\ntitle: Welcome\n---\nHello!\n`,
      'src/data/legacy-archive.json': monolithicJson,
      'src/components/HeroBanner.astro': `---
const { title, subtitle } = Astro.props;
---
<header>
  <h1>{title}</h1>
  <p>{subtitle}</p>
</header>
`,
      'src/components/StaticReactCard.tsx': `export function StaticReactCard() { return <div>Static JSX</div>; }\n`,
      'src/pages/index.astro': `---
import HeroBanner from '../components/HeroBanner.astro';
import { StaticReactCard } from '../components/StaticReactCard.tsx';
const slug = 'featured';
---
<HeroBanner title="Welcome Home" subtitle="Sundays at 10:30 AM" />
<h2><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /></svg> Plan Your Visit</h2>
<StaticReactCard />
<img src="/images/community/picnic.png" alt="Picnic" />
<img src={\`/images/cards/\${slug}.png\`} alt="Dynamic card" />
`,
      'src/pages/about.astro': `---
import HeroBanner from '../components/HeroBanner.astro';
---
<HeroBanner title="About Our Church" subtitle="Rooted in Hayward" />
`,
      'public/images/community/picnic.png': bigPng,
      'public/favicon.png': bigPng,
      'public/og-image.png': bigPng,
      'public/images/cards/featured.png': bigPng,
      '.github/workflows/deploy.yml': `name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: withastro/action@v3\n  deploy:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/deploy-pages@v4\n`,
      '.github/workflows/ci.yml': `name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`,
    });

    try {
      const { report } = await scanBareGitRepo(bareDir, {
        repoSlug: 'vrwarp/unoptimized-site',
        baseBranch: 'main',
      });

      expect(report.score).toBeLessThan(70);
      const titles = report.findings.map((f) => f.title);

      // Pillar 1: prop-locked component + nested SVG beside text
      expect(titles.some((t) => t.includes('Unlock inline editing in <HeroBanner>'))).toBe(true);
      expect(titles.some((t) => t.includes('Wrap text beside inline icons'))).toBe(true);

      // Pillar 2: monolithic JSON
      expect(titles.some((t) => t.includes('src/data/legacy-archive.json'))).toBe(true);

      // Pillar 3: static .tsx without client:*
      expect(titles.some((t) => t.includes('StaticReactCard'))).toBe(true);

      // Pillar 4: AGENTS.md missing subpath rule, missing content.config.ts, missing check script
      expect(titles.some((t) => t.includes('`/subpath`'))).toBe(true);
      expect(titles.some((t) => t.includes('src/content.config.ts'))).toBe(true);
      expect(titles.some((t) => t.includes('"check": "astro check"'))).toBe(true);

      // Pillar 5: WebP candidate ONLY for picnic.png (favicon, og-image, and dynamic /images/cards/ excluded!)
      const webpPaths = report.findings
        .filter((f) => f.actionKind === 'deterministic_webp')
        .map((f) => f.webpCandidate?.publicRelPath);
      expect(webpPaths).toEqual(['images/community/picnic.png']);

      // Pillar 5: .gitignore + workflow YAML suggestions with GitHub edit URLs
      expect(report.findings.some((f) => f.actionKind === 'deterministic_gitignore')).toBe(true);
      const wfFindings = report.findings.filter((f) => f.actionKind === 'workflow_yaml');
      expect(wfFindings).toHaveLength(2);
      const deployWf = wfFindings.find((f) =>
        f.workflowSuggestion?.targetPath.endsWith('deploy.yml'),
      );
      expect(deployWf?.workflowSuggestion?.githubEditUrl).toBe(
        'https://github.com/vrwarp/unoptimized-site/edit/main/.github/workflows/deploy.yml',
      );
      expect(deployWf?.workflowSuggestion?.yamlContent).toContain('sleep 3');
    } finally {
      await cleanup();
    }
  });

  it('executes $0 deterministic WebP conversion, src/ reference rewrites, original deletion, and .gitignore update', async () => {
    const bigPng = await generateLargeNoisyPng();
    const { workDir, bareDir, cleanup } = await createRepoWithFiles({
      '.gitignore': 'node_modules/\n',
      'public/images/community/picnic.png': bigPng,
      'src/pages/index.astro': `---\nimport { url } from '../lib/url';\n---\n<img src={url('/images/community/picnic.png')} alt="Church picnic" />\n`,
    });

    try {
      const { report } = await scanBareGitRepo(bareDir, {
        repoSlug: 'vrwarp/test-site',
        baseBranch: 'main',
      });
      const deterministic = report.findings.filter(
        (f) => f.actionKind === 'deterministic_webp' || f.actionKind === 'deterministic_gitignore',
      );
      expect(deterministic).toHaveLength(2);

      const prePass = await runDeterministicOptimizationPrePass(workDir, deterministic, {
        name: 'Admin User',
        email: 'admin@example.com',
      });

      expect(prePass.checkpoint).not.toBeNull();
      expect(prePass.completedSummaries).toHaveLength(2);
      expect(prePass.agentFindings).toHaveLength(0);

      // Original .png deleted, smaller .webp created
      await expect(
        fs.access(path.join(workDir, 'public/images/community/picnic.png')),
      ).rejects.toThrow();
      const webpStat = await fs.stat(path.join(workDir, 'public/images/community/picnic.webp'));
      expect(webpStat.size).toBeGreaterThan(0);
      expect(webpStat.size).toBeLessThan(bigPng.length);

      // Astro reference rewritten
      const updatedAstro = await fs.readFile(path.join(workDir, 'src/pages/index.astro'), 'utf8');
      expect(updatedAstro).toContain("url('/images/community/picnic.webp')");
      expect(updatedAstro).not.toContain('picnic.png');

      // .gitignore updated
      const updatedGitignore = await fs.readFile(path.join(workDir, '.gitignore'), 'utf8');
      expect(updatedGitignore).toContain('dist/');
      expect(updatedGitignore).toContain('.astro/');

      // Prompt builder includes deterministic pre-pass summary when combined with agent findings
      const prompt = buildOptimizationPrompt({
        completedDeterministic: prePass.completedSummaries,
        agentFindings: report.findings.filter((f) => f.actionKind === 'agent_refactor'),
      });
      expect(prompt).toContain('Already Completed Deterministically');
      expect(prompt).toContain('never touch `.github/**`');
    } finally {
      await cleanup();
    }
  });
});
