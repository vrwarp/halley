/**
 * Decides whether a repository's pull-request CI only repeats checks Halley already runs locally
 * before publishing (`npm run check`, `npm run build`, every `verify:*` script, or the commands in
 * `.halley.json` `checks`). The publish fast path (merge without waiting for CI) is only safe when
 * that holds; the optimizer reports the gaps so they can be moved into `verify:*` scripts.
 *
 * The analysis is deliberately conservative: anything it does not recognise counts as a gap.
 */

import { HalleyRepoConfigSchema } from './protocol.js';

export interface CiCoverageGap {
  /** Workflow file path, e.g. `.github/workflows/ci.yml`. */
  workflow: string;
  /** Step name (or its command when unnamed). */
  step: string;
  /** Why the step is not covered by Halley's local checks. */
  detail: string;
  /** 1-based line of the step in the workflow file. */
  line: number;
}

export interface CiCoverageReport {
  /** Workflows that run on pull requests. */
  prWorkflows: string[];
  gaps: CiCoverageGap[];
  /** True when every pull-request CI step is setup or a check Halley runs locally. */
  covered: boolean;
}

export interface CiCoverageOptions {
  /**
   * Commands from `.halley.json` `checks`. When non-empty Halley runs exactly these instead of the
   * default `check` / `build` / `verify:*` scripts, so only these commands count as covered.
   */
  halleyCheckCommands?: string[];
}

/** Actions that only prepare the runner or move artifacts around: they are not checks. */
const SETUP_ACTION_RE =
  /^(?:actions\/(?:checkout|setup-node|cache|configure-pages|upload-artifact|download-artifact|upload-pages-artifact|deploy-pages)|pnpm\/action-setup|oven-sh\/setup-bun)@/;

const INSTALL_COMMAND_RE =
  /^(?:npm (?:ci|install|i)|pnpm (?:install|i)|yarn(?: install)?|bun install|corepack enable)(?:\s+--[\w-]+(?:=\S+)?)*$/;

const RUN_SCRIPT_RE = /^(?:(?:npm|pnpm|yarn|bun) run|pnpm|yarn) ([\w:.-]+)$/;

const DEFAULT_COVERED_SCRIPT_RE = /^(?:check|build|verify:.+)$/;

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function stripComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, '$1');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

interface WorkflowStep {
  line: number;
  name?: string;
  uses?: string;
  run?: string;
}

interface ParsedWorkflow {
  steps: WorkflowStep[];
  /** Lines of job-level `uses:` (reusable workflows), which cannot be inspected. */
  reusableWorkflowLines: number[];
}

/** Line-based extraction of `steps:` entries; enough for the subset of YAML workflows use. */
function parseWorkflow(text: string): ParsedWorkflow {
  const lines = text.split(/\r?\n/);
  const steps: WorkflowStep[] = [];
  const reusableWorkflowLines: number[] = [];
  let stepsIndent = -1;
  let itemIndent = -1;
  let current: WorkflowStep | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = indentOf(line);

    if (stepsIndent >= 0) {
      const isItem = /^\s*-(?:\s|$)/.test(line);
      const leavesBlock = indent < stepsIndent || (indent === stepsIndent && !isItem);
      if (leavesBlock) {
        stepsIndent = -1;
        itemIndent = -1;
        current = null;
      } else {
        let content = line.trim();
        let keyIndent = indent;
        if (isItem && (itemIndent < 0 || indent === itemIndent)) {
          itemIndent = indent;
          current = { line: i + 1 };
          steps.push(current);
          const afterDash = line.replace(/^(\s*-\s*)/, '');
          keyIndent = line.length - afterDash.length;
          content = afterDash.trim();
        }
        const m = /^(name|uses|run)\s*:\s*(.*)$/.exec(content);
        if (current && m) {
          const key = m[1] as 'name' | 'uses' | 'run';
          const value = m[2]!.trim();
          if (key === 'run' && /^[|>][+-]?\d*$/.test(value)) {
            const block: string[] = [];
            while (i + 1 < lines.length) {
              const next = lines[i + 1]!;
              if (next.trim() && indentOf(next) <= keyIndent) break;
              block.push(next);
              i++;
            }
            current.run = block.join('\n');
          } else {
            current[key] = unquote(value);
          }
        }
        continue;
      }
    }

    if (/^\s*steps\s*:\s*$/.test(line)) {
      stepsIndent = indent;
      itemIndent = -1;
      current = null;
    } else if (/^\s+uses\s*:\s*\S/.test(line)) {
      reusableWorkflowLines.push(i + 1);
    }
  }
  return { steps, reusableWorkflowLines };
}

/** Returns the reason a shell script is not covered, or null when every command is. */
function uncoveredReason(script: string, opts: CiCoverageOptions): string | null {
  const custom = (opts.halleyCheckCommands ?? []).map(normalizeCommand).filter(Boolean);
  const whole = normalizeCommand(script.replace(/\\\r?\n/g, ' '));
  if (custom.includes(whole)) return null;

  const commands = script
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n|&&/)
    .map((c) => normalizeCommand(stripComment(c)))
    .filter(Boolean);
  for (const command of commands) {
    if (custom.includes(command)) continue;
    if (INSTALL_COMMAND_RE.test(command)) continue;
    const script = RUN_SCRIPT_RE.exec(command)?.[1];
    if (script && custom.length === 0 && DEFAULT_COVERED_SCRIPT_RE.test(script)) continue;
    const short = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    return custom.length > 0
      ? `runs \`${short}\`, which is not one of the \`.halley.json\` checks`
      : `runs \`${short}\`, which Halley does not run before publishing`;
  }
  return null;
}

export function isPullRequestWorkflow(text: string): boolean {
  const uncommented = text.split(/\r?\n/).map(stripComment).join('\n');
  return /\bpull_request(?:_target)?\b/.test(uncommented);
}

export function analyzeCiCoverage(
  workflows: Array<{ path: string; text: string }>,
  opts: CiCoverageOptions = {},
): CiCoverageReport {
  const prWorkflows: string[] = [];
  const gaps: CiCoverageGap[] = [];
  for (const wf of workflows) {
    if (!isPullRequestWorkflow(wf.text)) continue;
    prWorkflows.push(wf.path);
    const parsed = parseWorkflow(wf.text);
    for (const line of parsed.reusableWorkflowLines) {
      gaps.push({
        workflow: wf.path,
        step: 'Reusable workflow',
        detail: 'calls a reusable workflow, which Halley cannot inspect',
        line,
      });
    }
    for (const step of parsed.steps) {
      if (step.uses !== undefined) {
        if (!SETUP_ACTION_RE.test(step.uses)) {
          gaps.push({
            workflow: wf.path,
            step: step.name || step.uses,
            detail: `uses the action \`${step.uses}\`, which Halley does not run before publishing`,
            line: step.line,
          });
        }
        continue;
      }
      if (step.run === undefined) continue;
      const reason = uncoveredReason(step.run, opts);
      if (reason) {
        gaps.push({
          workflow: wf.path,
          step: step.name || normalizeCommand(step.run).slice(0, 60),
          detail: reason,
          line: step.line,
        });
      }
    }
  }
  return { prWorkflows, gaps, covered: gaps.length === 0 };
}

/**
 * Commands from a `.halley.json` file's `checks`. Missing, unreadable or check-less configs yield
 * none, matching the runner, which then falls back to the default scripts.
 */
export function parseHalleyCheckCommands(halleyJsonText: string | null | undefined): string[] {
  if (!halleyJsonText) return [];
  try {
    const parsed = HalleyRepoConfigSchema.safeParse(JSON.parse(halleyJsonText));
    return parsed.success ? (parsed.data.checks ?? []).map((c) => c.command) : [];
  } catch {
    // invalid JSON: the runner ignores the file and runs the default checks
    return [];
  }
}
