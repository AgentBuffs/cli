/**
 * The command: fetch the setup document, choose, show the plan, confirm,
 * apply, report. Every outside effect comes in through `CliIo`, so tests run
 * the whole flow on a temp home with scripted answers.
 *
 * Exit codes: 0 done (or nothing to do), 1 a failure, 2 a usage problem or a
 * non-interactive run without `--client` and `--yes`, 130 cancelled.
 */
import { parseArgs } from 'node:util';
import { applyPlan, type StepResult } from './apply.ts';
import { isHarnessPresent } from './detect.ts';
import { DEFAULT_API, NetworkError, fetchSetupDocument, fetchSkillText } from './network.ts';
import type { RunContext } from './paths.ts';
import { PARTS_FOR, buildPlan, isActionable, type SkillText, type Step, type What } from './plan.ts';
import { CancelledError, type HarnessChoice, type Prompter } from './prompts.ts';
import { backupLine, closing, detailLines, manualLines, planLines, resultLines } from './render.ts';
import type { Screen } from './screen.ts';
import type { ExecFn } from './run-action.ts';
import { SetupDocumentError, UnsupportedSetupVersionError, type Harness, type SetupDocument } from './setup-document.ts';

export type CliIo = {
  argv: readonly string[];
  /** Raw output for --help and --version, before the screen starts. */
  out: (text: string) => void;
  /** True when stdin and stdout are both terminals, so questions can be asked. */
  isInteractive: boolean;
  ctx: RunContext;
  prompter: Prompter;
  screen: Screen;
  exec: ExecFn;
  version: string;
};

export const EXIT = { ok: 0, failed: 1, usage: 2, cancelled: 130 } as const;

function helpText(version: string): string {
  return `agentbuffs ${version}
Adds the agentbuffs MCP server and skill to your agents.

Usage
  npx agentbuffs [options]

Options
  --client <slugs>   Agents to set up, comma separated: claude-code,cursor
  --what <part>      mcp, skill or both
  -y, --yes          Install without asking
  --dry-run          Show every change and write nothing
  --verbose          Show every change before asking
  --api <url>        Setup server (default ${DEFAULT_API})
  -v, --version      Print the version
  -h, --help         Print this help

Without a terminal, pass --client and --yes, or --dry-run.
https://agentbuffs.com   Privacy: https://agentbuffs.com/privacy`;
}

class UsageError extends Error {
  override name = 'UsageError';
}

type Options = {
  clients: string[] | null;
  what: What | null;
  yes: boolean;
  dryRun: boolean;
  verbose: boolean;
  api: string;
  help: boolean;
  version: boolean;
};

const WHAT_VALUES: readonly What[] = ['mcp', 'skill', 'both'];

function isWhat(value: string): value is What {
  return WHAT_VALUES.some((what) => what === value);
}

function readOptions(argv: readonly string[]): Options {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: false,
        options: {
          client: { type: 'string' },
          what: { type: 'string' },
          yes: { type: 'boolean', short: 'y' },
          'dry-run': { type: 'boolean' },
          verbose: { type: 'boolean' },
          api: { type: 'string' },
          version: { type: 'boolean', short: 'v' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  })();
  const { values } = parsed;
  if (values.what !== undefined && !isWhat(values.what)) throw new UsageError(`--what must be mcp, skill or both, not "${values.what}"`);
  const clients = values.client === undefined ? null : values.client.split(',').map((slug) => slug.trim()).filter(Boolean);
  if (clients !== null && clients.length === 0) throw new UsageError('--client needs at least one slug');
  return {
    clients,
    what: values.what ?? null,
    yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false,
    verbose: values.verbose ?? false,
    api: values.api ?? DEFAULT_API,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

function harnessesBySlug(doc: SetupDocument, slugs: readonly string[]): Harness[] {
  const unknown = slugs.filter((slug) => !doc.harnesses.some((harness) => harness.slug === slug));
  if (unknown.length > 0) {
    const known = doc.harnesses.map((harness) => harness.slug).join(', ');
    throw new UsageError(`Unknown --client ${unknown.join(', ')}. Known: ${known}`);
  }
  return doc.harnesses.filter((harness) => slugs.includes(harness.slug));
}

async function chooseHarnesses(opts: { doc: SetupDocument; found: ReadonlySet<string>; io: CliIo; options: Options }): Promise<Harness[]> {
  const { doc, found, io, options } = opts;
  if (options.clients !== null) return harnessesBySlug(doc, options.clients);
  if (!io.isInteractive) return doc.harnesses.filter((harness) => found.has(harness.slug));
  const ordered = [...doc.harnesses.filter((h) => found.has(h.slug)), ...doc.harnesses.filter((h) => !found.has(h.slug))];
  const choices: HarnessChoice[] = ordered.map((harness) => ({ slug: harness.slug, label: harness.name, hint: found.has(harness.slug) ? 'found' : null }));
  const picked = await io.prompter.chooseHarnesses({ choices, preselected: [...found] });
  return harnessesBySlug(doc, picked);
}

async function chooseWhat(opts: { doc: SetupDocument; harnesses: readonly Harness[]; io: CliIo; options: Options }): Promise<What> {
  if (opts.options.what !== null) return opts.options.what;
  const anySkill = opts.doc.skill !== null && opts.harnesses.some((harness) => harness.skill !== null);
  if (!anySkill || !opts.io.isInteractive) return anySkill ? 'both' : 'mcp';
  return opts.io.prompter.chooseWhat();
}

async function loadSkillText(opts: { doc: SetupDocument; harnesses: readonly Harness[]; what: What; options: Options; io: CliIo }): Promise<SkillText> {
  const wantsSkill = PARTS_FOR[opts.what].includes('skill') && opts.harnesses.some((harness) => harness.skill?.kind === 'file');
  if (!wantsSkill || opts.doc.skill === null) return null;
  try {
    return { ok: true, text: await fetchSkillText({ skill: opts.doc.skill, api: opts.options.api, version: opts.io.version }) };
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return { ok: false, reason: error.message };
  }
}

/** Asks about each different existing entry before anything is written. */
async function approveReplacements(steps: readonly Step[], opts: { io: CliIo; yes: boolean }): Promise<Set<Step>> {
  const approved = new Set<Step>();
  for (const step of steps) {
    if (step.plan.kind !== 'write' || step.plan.change !== 'replace') continue;
    if (opts.yes) {
      approved.add(step);
      continue;
    }
    const isApproved = await opts.io.prompter.confirm(`${step.harness.name} already has a different agentbuffs ${step.part === 'mcp' ? 'entry' : 'skill file'}. Replace it?`);
    if (isApproved) approved.add(step);
  }
  return approved;
}

function hasFailure(results: readonly StepResult[]): boolean {
  return results.some((result) => result.status === 'failed');
}

/** Runs `work` under a spinner that disappears when it is done. */
async function withSpinner<Value>(opts: { io: CliIo; text: string; work: () => Promise<Value> }): Promise<Value> {
  const spinner = opts.io.screen.spinner(opts.text);
  try {
    return await opts.work();
  } finally {
    spinner.clear();
  }
}

/** Shows the plan, and asks until the answer is install or cancel. True means install. */
async function confirmPlan(opts: { io: CliIo; showDetails: () => void; isShown: boolean }): Promise<boolean> {
  let isShown = opts.isShown;
  for (let round = 0; round < 2; round += 1) {
    const action = await opts.io.prompter.choosePlanAction({ canShowDetails: !isShown });
    if (action === 'install') return true;
    if (action === 'cancel') return false;
    opts.showDetails();
    isShown = true;
  }
  throw new Error('The plan question was asked more than twice');
}

/** Applies the plan one harness at a time, under a spinner that names it. */
async function applyWithProgress(opts: { io: CliIo; steps: readonly Step[]; doc: SetupDocument; approvedReplacements: ReadonlySet<Step> }): Promise<StepResult[]> {
  const { io } = opts;
  const harnesses = [...new Set(opts.steps.map((step) => step.harness))];
  const spinner = io.screen.spinner('Installing');
  const results: StepResult[] = [];
  for (const harness of harnesses) {
    spinner.message(`Setting up ${harness.name}`);
    const steps = opts.steps.filter((step) => step.harness === harness);
    results.push(...(await applyPlan(steps, { doc: opts.doc, ctx: io.ctx, exec: io.exec, approvedReplacements: opts.approvedReplacements })));
  }
  const isOk = !hasFailure(results);
  spinner.stop({ text: isOk ? 'Done' : 'Done, with problems', isOk });
  return results;
}

function showResults(opts: { io: CliIo; steps: readonly Step[]; results: readonly StepResult[] }): void {
  const { io } = opts;
  const { paint } = io.screen;
  io.screen.list(resultLines({ results: opts.results, paint }));
  const manual = manualLines({ steps: opts.steps, paint, width: io.screen.width });
  if (manual.length > 0) io.screen.section({ title: 'Set up by hand', lines: manual });
  const backups = backupLine({ results: opts.results, ctx: io.ctx });
  if (backups !== null) io.screen.aside(backups);
  io.screen.end(closing(opts.results));
}

async function run(io: CliIo): Promise<number> {
  const options = readOptions(io.argv);
  if (options.help) {
    io.out(helpText(io.version));
    return EXIT.ok;
  }
  if (options.version) {
    io.out(io.version);
    return EXIT.ok;
  }

  const { screen } = io;
  screen.start(io.version);
  const doc = await withSpinner({ io, text: 'Getting the list of agents', work: () => fetchSetupDocument({ api: options.api, version: io.version }) });
  const found = new Set(doc.harnesses.filter((harness) => isHarnessPresent(harness, io.ctx)).map((harness) => harness.slug));
  const harnesses = await chooseHarnesses({ doc, found, io, options });
  const what = await chooseWhat({ doc, harnesses, io, options });
  const skillText = await withSpinner({ io, text: 'Getting the skill', work: () => loadSkillText({ doc, harnesses, what, options, io }) });
  const steps = buildPlan({ harnesses, what, input: { doc, ctx: io.ctx, skillText } });
  const showDetails = (): void => screen.section({ title: 'Changes', lines: detailLines({ steps, ctx: io.ctx, paint: screen.paint, width: screen.width }) });
  screen.note({ title: 'Plan', lines: steps.length === 0 ? ['nothing selected'] : planLines(steps) });

  if (!io.isInteractive && (options.clients === null || (!options.yes && !options.dryRun))) {
    const noneFound = options.clients === null && harnesses.length === 0 ? `No agent found. Pick one with --client: ${doc.harnesses.map((h) => h.slug).join(', ')}\n` : '';
    screen.fail(`${noneFound}No terminal to ask in. Run again with --client <slug,...> --yes to install, or add --dry-run to see every change.`);
    return EXIT.usage;
  }
  const isDetailShown = options.verbose || options.dryRun;
  if (isDetailShown) showDetails();
  if (options.dryRun) {
    const manual = manualLines({ steps, paint: screen.paint, width: screen.width });
    if (manual.length > 0) screen.section({ title: 'Set up by hand', lines: manual });
    screen.end({ lines: ['Dry run. Nothing was written.'], aside: null });
    return EXIT.ok;
  }
  if (steps.some(isActionable) && !options.yes && !(await confirmPlan({ io, showDetails, isShown: isDetailShown }))) {
    screen.end({ lines: ['Nothing was written.'], aside: null });
    return EXIT.ok;
  }
  const approvedReplacements = await approveReplacements(steps, { io, yes: options.yes });
  const results = await applyWithProgress({ io, steps, doc, approvedReplacements });
  showResults({ io, steps, results });
  return hasFailure(results) ? EXIT.failed : EXIT.ok;
}

/** Runs the command and returns the exit code. Never throws for an expected problem. */
export async function main(io: CliIo): Promise<number> {
  try {
    return await run(io);
  } catch (error) {
    if (error instanceof CancelledError) {
      io.screen.fail('Cancelled. Nothing was written.');
      return EXIT.cancelled;
    }
    if (error instanceof UsageError) {
      io.screen.fail(`${error.message}\nRun agentbuffs --help for the options.`);
      return EXIT.usage;
    }
    if (error instanceof NetworkError || error instanceof SetupDocumentError || error instanceof UnsupportedSetupVersionError) {
      io.screen.fail(error.message);
      return EXIT.failed;
    }
    throw error;
  }
}
