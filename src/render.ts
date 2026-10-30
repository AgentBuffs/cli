/**
 * The text the CLI shows: the compact plan (one line per harness), the
 * detailed changes, the result lines, the manual steps and the closing words.
 * Every function returns plain lines, coloured only through the `Paint` it is
 * given, so a pipe, a test and a terminal share the same words. Pure.
 */
import type { Paint } from './ansi.ts';
import type { StepResult } from './apply.ts';
import { displayPath, type RunContext } from './paths.ts';
import type { Part, Step, StepPlan, What } from './plan.ts';
import { commandLine } from './run-action.ts';
import type { Harness } from './setup-document.ts';

const PART_NAME: Readonly<Record<Part, string>> = { mcp: 'MCP server', skill: 'skill' };
const PART_SHORT: Readonly<Record<Part, string>> = { mcp: 'MCP', skill: 'skill' };

/** The three answers to "What should they get?", as the question and the summary show them. */
export const PART_CHOICE: Readonly<Record<What, string>> = { both: 'MCP server and skill', mcp: 'MCP server only', skill: 'Skill only' };

/** The example the closing words suggest. */
export const EXAMPLE_ASK = 'Find me an MCP server for Postgres.';

/** Groups items by harness, in first-seen order. */
function byHarness<Item>(items: readonly Item[], harnessOf: (item: Item) => Harness): Array<[Harness, Item[]]> {
  const groups = new Map<Harness, Item[]>();
  for (const item of items) groups.set(harnessOf(item), [...(groups.get(harnessOf(item)) ?? []), item]);
  return [...groups];
}

/** The harness name padded so the second column lines up. */
function nameColumn(names: readonly string[]): (name: string) => string {
  const width = Math.max(0, ...names.map((name) => name.length)) + 3;
  return (name) => name.padEnd(width);
}

/** The first phrase as it is, the others in parentheses: `MCP server (skill already set up)`. */
function joinPhrases(phrases: readonly string[]): string {
  const [first, ...rest] = phrases;
  if (first === undefined) return 'nothing to do';
  if (rest.length === 0) return first;
  return `${first} (${rest.join(', ')})`;
}

/** `MCP server + skill`, or `skill` alone. */
function partNames(parts: readonly Part[]): string {
  return parts.map((part) => PART_NAME[part]).join(' + ');
}

/** `already set up` when it is the whole story, else `skill already set up`. */
function sharedPhrase(opts: { parts: readonly Part[]; isAlone: boolean; phrase: string }): string {
  return opts.isAlone ? opts.phrase : `${partNames(opts.parts)} ${opts.phrase}`;
}

function planSummary(steps: readonly Step[]): string {
  const partsWhere = (kinds: readonly StepPlan['kind'][]): Part[] => steps.filter((step) => kinds.includes(step.plan.kind)).map((step) => step.part);
  const installs = partsWhere(['write', 'run']);
  const already = partsWhere(['already']);
  const manual = partsWhere(['manual']);
  const refusals = steps.flatMap((step) => (step.plan.kind === 'refused' ? [`${PART_SHORT[step.part]}: ${step.plan.reason}`] : []));
  const groupCount = [installs, already, manual].filter((parts) => parts.length > 0).length + refusals.length;
  const isAlone = groupCount === 1;
  const phrases = [
    ...(installs.length > 0 ? [partNames(installs)] : []),
    ...refusals,
    ...(already.length > 0 ? [sharedPhrase({ parts: already, isAlone, phrase: 'already set up' })] : []),
    ...(manual.length > 0 ? [sharedPhrase({ parts: manual, isAlone, phrase: isAlone ? 'manual steps, shown at the end' : 'by hand, steps at the end' })] : []),
  ];
  return joinPhrases(phrases);
}

/** One line per harness: `Claude Code    MCP server + skill`. */
export function planLines(steps: readonly Step[]): string[] {
  const groups = byHarness(steps, (step) => step.harness);
  const pad = nameColumn(groups.map(([harness]) => harness.name));
  return groups.map(([harness, list]) => `${pad(harness.name)}${planSummary(list)}`);
}

const CHANGE_TEXT = {
  create: 'create',
  add: 'add to',
  replace: 'replace the agentbuffs entry in',
} as const;

function detailOf(plan: StepPlan, ctx: RunContext): string[] {
  switch (plan.kind) {
    case 'write': {
      const backup = plan.original === null ? '' : ', backup first';
      return [`${CHANGE_TEXT[plan.change]} ${displayPath(plan.file, ctx)}${backup}`, ...plan.preview];
    }
    case 'already':
      return [`already in ${displayPath(plan.file, ctx)}`];
    case 'run':
      return [`run ${commandLine(plan.action)}`];
    case 'manual':
      return ['manual steps:', ...plan.lines.map((line) => `  ${line}`)];
    case 'refused':
      return [`will not change: ${plan.reason}`];
    case 'not-offered':
      return ['not offered for this agent'];
  }
}

/**
 * Breaks `text` at spaces into lines of at most `width` columns. Leading
 * spaces stay; later lines start with `indent` spaces. A word longer than the
 * width stays whole.
 */
export function wrapText(opts: { text: string; width: number; indent: number }): string[] {
  if (opts.text.length <= opts.width) return [opts.text];
  const lead = /^ */.exec(opts.text)?.[0] ?? '';
  const pad = ' '.repeat(opts.indent);
  const lines: string[] = [];
  let line = lead;
  for (const word of opts.text.slice(lead.length).split(' ')) {
    const isLineEmpty = line.trim() === '';
    // A word that cannot fit on a line of its own (a long URL) stays where it is, whole.
    const fitsAlone = pad.length + word.length <= opts.width;
    if (!isLineEmpty && fitsAlone && line.length + 1 + word.length > opts.width) {
      lines.push(line);
      line = pad + word;
      continue;
    }
    line = isLineEmpty ? line + word : `${line} ${word}`;
  }
  return [...lines, line];
}

/** Every change, per harness and part: paths, entries and commands, wrapped to `width`. */
export function detailLines(opts: { steps: readonly Step[]; ctx: RunContext; paint: Paint; width: number }): string[] {
  const label = (part: Part): string => PART_SHORT[part].padEnd(7);
  const indent = label('mcp').length + 2;
  const wrap = (text: string): string[] => wrapText({ text, width: opts.width, indent: indent + 2 });
  return byHarness(opts.steps, (step) => step.harness).flatMap(([harness, list], index) => [
    ...(index === 0 ? [] : ['']),
    opts.paint.bold(harness.name),
    ...list.flatMap((step) => {
      const [first = '', ...rest] = detailOf(step.plan, opts.ctx);
      return [...wrap(`  ${label(step.part)}${first}`), ...rest.flatMap((line) => wrap(`${' '.repeat(indent)}${line}`)).map(opts.paint.dim)];
    }),
  ]);
}

type Mark = 'done' | 'same' | 'failed';

const MARK_TEXT: Readonly<Record<Mark, string>> = { done: '✓', same: '•', failed: '✗' };

function markOf(results: readonly StepResult[]): Mark {
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.some((result) => result.status === 'done')) return 'done';
  return 'same';
}

function paintMark(mark: Mark, paint: Paint): string {
  switch (mark) {
    case 'done':
      return paint.green(MARK_TEXT.done);
    case 'same':
      return paint.dim(MARK_TEXT.same);
    case 'failed':
      return paint.red(MARK_TEXT.failed);
  }
}

function resultSummary(results: readonly StepResult[]): string {
  const partsWith = (status: StepResult['status']): Part[] => results.filter((result) => result.status === status).map((result) => result.step.part);
  const explained = (status: StepResult['status']): string[] =>
    results.filter((result) => result.status === status).map((result) => `${PART_SHORT[result.step.part]}: ${result.detail}`);
  const failures = explained('failed');
  const skips = explained('skipped');
  const done = partsWith('done');
  const already = partsWith('already');
  const manual = partsWith('manual');
  const groupCount = failures.length + skips.length + [done, already, manual].filter((parts) => parts.length > 0).length;
  const isAlone = groupCount === 1;
  return joinPhrases([
    ...(done.length > 0 ? [partNames(done)] : []),
    ...failures,
    ...skips,
    ...(already.length > 0 ? [sharedPhrase({ parts: already, isAlone, phrase: 'already set up' })] : []),
    ...(manual.length > 0 ? [sharedPhrase({ parts: manual, isAlone, phrase: isAlone ? 'manual steps below' : 'by hand, steps below' })] : []),
  ]);
}

/**
 * One line per harness: `✓ Claude Code    MCP server + skill`, `• Codex    already set up`, `✗ ...`.
 * `names` sets the name column's width; pass every harness of the run, so the
 * lines do not move while results arrive one by one.
 */
export function resultLines(opts: { results: readonly StepResult[]; paint: Paint; names?: readonly string[] }): string[] {
  const groups = byHarness(opts.results, (result) => result.step.harness);
  const pad = nameColumn(opts.names ?? groups.map(([harness]) => harness.name));
  return groups.map(([harness, list]) => `${paintMark(markOf(list), opts.paint)} ${pad(harness.name)}${resultSummary(list)}`);
}

/** The manual steps of every harness that has some, under its name, wrapped to `width`. */
export function manualLines(opts: { steps: readonly Step[]; paint: Paint; width: number }): string[] {
  return byHarness(opts.steps, (step) => step.harness).flatMap(([harness, list]) => {
    const lines = list.flatMap((step) => (step.plan.kind === 'manual' ? step.plan.lines : []));
    if (lines.length === 0) return [];
    return [opts.paint.bold(harness.name), ...lines.flatMap((line) => wrapText({ text: `  ${line}`, width: opts.width, indent: 4 }))];
  });
}

/** `Backups: ~/.cursor/mcp.json.bak, ...`, or null when nothing was backed up. */
export function backupLine(opts: { results: readonly StepResult[]; ctx: RunContext }): string | null {
  const backups = opts.results.flatMap((result) => (result.backup === null ? [] : [displayPath(result.backup, opts.ctx)]));
  if (backups.length === 0) return null;
  return `Backups: ${backups.join(', ')}`;
}

/** `Claude Code, Cursor and Codex`. */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

export type Closing = { lines: string[]; aside: string | null };

const RATE_ASIDE = 'After your agent installs a tool, it can rate it on agentbuffs.com.';

/** The last words: what to restart and what to ask the agent. */
export function closing(results: readonly StepResult[]): Closing {
  const namesWith = (status: StepResult['status']): string[] => [
    ...new Set(results.filter((result) => result.status === status).map((result) => result.step.harness.name)),
  ];
  const restart = namesWith('done');
  const ask = `"${EXAMPLE_ASK}"`;
  if (restart.length > 0) return { lines: [`Restart ${listNames(restart)}, then ask your agent:`, ask], aside: RATE_ASIDE };
  if (namesWith('failed').length > 0) return { lines: ['Nothing new was installed. Fix the problem above and run agentbuffs again.'], aside: null };
  if (namesWith('already').length > 0) return { lines: ['Everything was already set up. Ask your agent:', ask], aside: RATE_ASIDE };
  if (namesWith('manual').length > 0) return { lines: ['Follow the steps above, then ask your agent:', ask], aside: RATE_ASIDE };
  return { lines: ['Nothing was installed.'], aside: null };
}
