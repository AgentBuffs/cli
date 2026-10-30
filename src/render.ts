/**
 * The plan and result text. Plain lines, so the same text works in a
 * terminal, in a pipe and in tests. Pure.
 */
import type { StepResult } from './apply.ts';
import { displayPath, type RunContext } from './paths.ts';
import type { Part, Step, StepPlan } from './plan.ts';
import { commandLine } from './run-action.ts';
import type { Harness } from './setup-document.ts';

const PART_LABEL: Readonly<Record<Part, string>> = { mcp: 'MCP', skill: 'skill' };

const CHANGE_TEXT = {
  create: 'create',
  add: 'add the entry to',
  replace: 'replace the different entry in',
} as const;

function planDetail(plan: StepPlan, ctx: RunContext): string[] {
  switch (plan.kind) {
    case 'write': {
      const backup = plan.original === null ? '' : ' (backup first)';
      return [`${CHANGE_TEXT[plan.change]} ${displayPath(plan.file, ctx)}${backup}`, ...plan.preview.map((line) => `  ${line}`)];
    }
    case 'already':
      return [`already there in ${displayPath(plan.file, ctx)}`];
    case 'run':
      return [`run ${commandLine(plan.action)}`];
    case 'manual':
      return ['by hand:', ...plan.lines.map((line) => `  ${line}`)];
    case 'refused':
      return [`will not change: ${plan.reason}`];
    case 'not-offered':
      return ['not offered for this harness'];
  }
}

/** The full plan: per harness, what happens to each part. */
export function planText(opts: { steps: readonly Step[]; ctx: RunContext; found: ReadonlySet<string> }): string {
  const lines = ['Plan:'];
  let current: Harness | null = null;
  for (const step of opts.steps) {
    if (step.harness !== current) {
      current = step.harness;
      lines.push(`  ${current.name}${opts.found.has(current.slug) ? ' (found)' : ''}`);
    }
    const [first = '', ...rest] = planDetail(step.plan, opts.ctx);
    lines.push(`    ${PART_LABEL[step.part]}: ${first}`, ...rest.map((line) => `      ${line}`));
  }
  if (opts.steps.length === 0) lines.push('  nothing selected');
  return lines.join('\n');
}

const STATUS_TEXT: Readonly<Record<StepResult['status'], string>> = {
  done: 'done',
  already: 'skipped: already there',
  skipped: 'skipped',
  failed: 'failed',
  manual: 'by hand',
  'not-offered': 'not offered',
};

function resultPhrase(result: StepResult): string {
  const label = `${PART_LABEL[result.step.part]} ${STATUS_TEXT[result.status]}`;
  if (result.status === 'already' || result.status === 'not-offered') return label;
  return `${label}: ${result.detail}`;
}

/** One line per harness: `Cursor: MCP done: wrote ~/.cursor/mcp.json; skill not offered`. */
export function resultText(results: readonly StepResult[]): string {
  const byHarness = new Map<Harness, StepResult[]>();
  for (const result of results) byHarness.set(result.step.harness, [...(byHarness.get(result.step.harness) ?? []), result]);
  return [...byHarness].map(([harness, list]) => `${harness.name}: ${list.map(resultPhrase).join('; ')}`).join('\n');
}

/** The closing line, naming the harnesses that now have something. */
export function finalHint(results: readonly StepResult[]): string {
  const ready = new Set<string>();
  for (const result of results) {
    if (result.status === 'done' || result.status === 'already') ready.add(result.step.harness.name);
  }
  if (ready.size === 0) return 'Nothing was installed.';
  return `Restart ${[...ready].join(', ')}, then ask your agent to find a tool.`;
}
