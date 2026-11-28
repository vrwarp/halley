import { describe, expect, it } from 'vitest';
import { analyzeCiCoverage } from './ci-coverage.js';

const HEAD = `name: CI
on:
  pull_request:
    branches: [ main ]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Type-check
        run: npm run check
      - name: Build
        run: npm run build
      - name: Verify SEO
        run: npm run verify:seo
`;

const analyze = (text: string, halleyCheckCommands?: string[]) =>
  analyzeCiCoverage([{ path: '.github/workflows/ci.yml', text }], { halleyCheckCommands });

describe('analyzeCiCoverage', () => {
  it('treats setup, install and check/build/verify:* scripts as covered', () => {
    const r = analyze(HEAD);
    expect(r.prWorkflows).toEqual(['.github/workflows/ci.yml']);
    expect(r.gaps).toEqual([]);
    expect(r.covered).toBe(true);
  });

  it('flags inline scripts, block scalars and unknown commands with their step and line', () => {
    const r = analyze(
      `${HEAD}      - name: Inline hygiene
        run: |
          node -e '
            console.log("# not a comment")
          '
      - run: npx eslint .
      - name: Chained
        run: npm run build && npm test
`,
    );
    expect(r.covered).toBe(false);
    expect(r.gaps.map((g) => g.step)).toEqual(['Inline hygiene', 'npx eslint .', 'Chained']);
    expect(r.gaps[0]!.line).toBe(HEAD.split('\n').length);
    expect(r.gaps[2]!.detail).toContain('npm test');
  });

  it('flags third-party actions and reusable workflows', () => {
    const r = analyze(`on: [pull_request]
jobs:
  shared:
    uses: org/repo/.github/workflows/lint.yml@main
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: super-linter/super-linter@v7
`);
    expect(r.gaps.map((g) => g.step)).toEqual(['Reusable workflow', 'super-linter/super-linter@v7']);
  });

  it('ignores workflows that do not run on pull requests, and comments mentioning them', () => {
    const r = analyze(`on:
  push:
    branches: [ main ] # not pull_request
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`);
    expect(r.prWorkflows).toEqual([]);
    expect(r.covered).toBe(true);
  });

  it('accepts pnpm/yarn shorthands and install flags, but not script arguments', () => {
    const steps = (cmds: string[]) =>
      `on: [pull_request]\njobs:\n  a:\n    steps:\n${cmds.map((c) => `      - run: ${c}\n`).join('')}`;
    expect(analyze(steps(['pnpm install --frozen-lockfile', 'pnpm check', 'yarn build', 'pnpm run verify:seo'])).covered).toBe(true);
    expect(analyze(steps(['npm run build -- --mode staging'])).covered).toBe(false);
    expect(analyze(steps(['npm run lint'])).covered).toBe(false);
  });

  it('with .halley.json checks, only those exact commands are covered', () => {
    const wf = `on: [pull_request]\njobs:\n  a:\n    steps:\n      - run: npm ci\n      - run: npm run lint\n      - run: npm run build\n`;
    const r = analyze(wf, ['npm run lint']);
    expect(r.gaps.map((g) => g.step)).toEqual(['npm run build']);
    expect(analyze(wf, ['npm run lint', 'npm  run build']).covered).toBe(true);
  });
});
