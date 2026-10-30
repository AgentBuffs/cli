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
import { CancelledError, type DetailsOffer, type HarnessChoice, type Prompter } from './prompts.ts';
import { PART_CHOICE, backupLine, closing, detailLines, listNames, manualLines, planLines, resultLines } from './render.ts';
import type { Screen } from './screen.ts';
import type { ExecFn } from './run-action.ts';
import { SetupDocumentError, UnsupportedSetupVersionError, type Harness, type SetupDocument } from './setup-document.ts';
import { toPages, type Answer, type WizardStep } from './wizard-view.ts';

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
  --no-fullscreen    Print line by line instead of one screen per step
  --api <url>        Setup server (default ${DEFAULT_API})
  -v, --version      Print the version
  -h, --help         Print this help

Without a terminal, pass --client and --yes, or --dry-run.
https://agentbuffs.com   Privacy: https://agentbuffs.com/privacy`;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

export type Options = {
  clients: string[] | null;
  what: What | null;
  yes: boolean;
  dryRun: boolean;
  verbose: boolean;
  noFullscreen: boolean;
  api: string;
  help: boolean;
  version: boolean;
};

const WHAT_VALUES: readonly What[] = ['mcp', 'skill', 'both'];

function isWhat(value: string): value is What {
  return WHAT_VALUES.some((what) => what === value);
}

/** The options in `argv`. Throws `UsageError` on an unknown flag or a bad value. */
export function readOptions(argv: readonly string[]): Options {
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
          'no-fullscreen': { type: 'boolean' },
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
    noFullscreen: values['no-fullscreen'] ?? false,
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

/** The answer to "what should they get" when nobody is asked, or null when the question is asked. */
function whatWithoutAsking(opts: { doc: SetupDocument; harnesses: readonly Harness[]; io: CliIo; options: Options }): What | null {
  if (opts.options.what !== null) return opts.options.what;
  const anySkill = opts.doc.skill !== null && opts.harnesses.some((harness) => harness.skill !== null);
  if (!anySkill || !opts.io.isInteractive) return anySkill ? 'both' : 'mcp';
  return null;
}

/**
 * The wizard's steps for this run: the agent list only without --client, the
 * parts question only without --what and when the setup offers a skill. The
 * parts step can still be answered without a question (no picked agent takes
 * a skill); it then counts as done.
 */
function wizardSteps(opts: { doc: SetupDocument; options: Options }): WizardStep[] {
  return [
    ...(opts.options.clients === null ? (['agents'] as const) : []),
    ...(opts.options.what === null && opts.doc.skill !== null ? (['parts'] as const) : []),
    'plan',
    'install',
  ];
}

/** Draws a step, if this run shows it. */
function enterStep(opts: { io: CliIo; steps: readonly WizardStep[]; step: WizardStep; answers: readonly Answer[] }): void {
  if (!opts.steps.includes(opts.step)) return;
  opts.io.screen.step({ place: { steps: opts.steps, current: opts.step }, answers: opts.answers });
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

/** What the plan question offers next: the first page of changes, the next one, or nothing more. */
function detailsOffer(opts: { nextPage: number; pages: number }): DetailsOffer {
  if (opts.nextPage >= opts.pages) return null;
  if (opts.nextPage === 0) return { kind: 'first' };
  return { kind: 'next', page: opts.nextPage + 1, pages: opts.pages };
}

/**
 * Asks until the answer is install or cancel; true means install. Each
 * "show" answer shows the next page of changes. A screen that scrolls has
 * one page, so the question offers it once.
 */
async function confirmPlan(opts: { io: CliIo; showPage: (page: number) => void; pages: number; shownPages: number }): Promise<boolean> {
  let nextPage = opts.shownPages;
  for (let round = 0; round <= opts.pages; round += 1) {
    const action = await opts.io.prompter.choosePlanAction({ details: detailsOffer({ nextPage, pages: opts.pages }) });
    if (action === 'install') return true;
    if (action === 'cancel') return false;
    if (nextPage >= opts.pages) throw new Error('No more changes to show');
    opts.showPage(nextPage);
    nextPage += 1;
  }
  throw new Error('The plan question was asked more often than there are pages');
}

/** Applies the plan one harness at a time, under a spinner that names it, with each finished harness's line above it. */
async function applyWithProgress(opts: { io: CliIo; steps: readonly Step[]; doc: SetupDocument; approvedReplacements: ReadonlySet<Step> }): Promise<StepResult[]> {
  const { io } = opts;
  const harnesses = [...new Set(opts.steps.map((step) => step.harness))];
  const names = harnesses.map((harness) => harness.name);
  const spinner = io.screen.spinner('Installing');
  const results: StepResult[] = [];
  for (const harness of harnesses) {
    spinner.message(`Setting up ${harness.name}`);
    const steps = opts.steps.filter((step) => step.harness === harness);
    results.push(...(await applyPlan(steps, { doc: opts.doc, ctx: io.ctx, exec: io.exec, approvedReplacements: opts.approvedReplacements })));
    spinner.progress(resultLines({ results, paint: io.screen.paint, names }));
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
  const wizard = wizardSteps({ doc, options });
  enterStep({ io, steps: wizard, step: 'agents', answers: [] });
  const harnesses = await chooseHarnesses({ doc, found, io, options });
  const agentsAnswer: Answer = { label: 'Agents', value: harnesses.length === 0 ? 'none' : listNames(harnesses.map((harness) => harness.name)) };
  const decidedWhat = whatWithoutAsking({ doc, harnesses, io, options });
  if (decidedWhat === null) enterStep({ io, steps: wizard, step: 'parts', answers: [agentsAnswer] });
  const what = decidedWhat ?? (await io.prompter.chooseWhat());
  const answers: Answer[] = [agentsAnswer, { label: 'Parts', value: PART_CHOICE[what] }];
  enterStep({ io, steps: wizard, step: 'plan', answers });
  const skillText = await withSpinner({ io, text: 'Getting the skill', work: () => loadSkillText({ doc, harnesses, what, options, io }) });
  const steps = buildPlan({ harnesses, what, input: { doc, ctx: io.ctx, skillText } });
  const plan = { title: 'Plan', lines: steps.length === 0 ? ['nothing selected'] : planLines(steps) };
  const changes = detailLines({ steps, ctx: io.ctx, paint: screen.paint, width: screen.width });
  const pages = toPages(changes, screen.pageRows());
  const showPage = (page: number): void =>
    screen.section({ title: pages.length === 1 ? 'Changes' : `Changes, page ${page + 1} of ${pages.length}`, lines: pages[page] ?? [] });

  if (!io.isInteractive && (options.clients === null || (!options.yes && !options.dryRun))) {
    screen.note(plan);
    const noneFound = options.clients === null && harnesses.length === 0 ? `No agent found. Pick one with --client: ${doc.harnesses.map((h) => h.slug).join(', ')}\n` : '';
    screen.fail(`${noneFound}No terminal to ask in. Run again with --client <slug,...> --yes to install, or add --dry-run to see every change.`);
    return EXIT.usage;
  }
  if (options.dryRun) {
    // A dry run's plan and changes are its result: they belong in the scrollback.
    await screen.leave();
    screen.note(plan);
    screen.section({ title: 'Changes', lines: changes });
    const manual = manualLines({ steps, paint: screen.paint, width: screen.width });
    if (manual.length > 0) screen.section({ title: 'Set up by hand', lines: manual });
    screen.end({ lines: ['Dry run. Nothing was written.'], aside: null });
    return EXIT.ok;
  }
  screen.note(plan);
  if (options.verbose) showPage(0);
  const shownPages = options.verbose ? 1 : 0;
  if (steps.some(isActionable) && !options.yes && !(await confirmPlan({ io, showPage, pages: pages.length, shownPages }))) {
    screen.end({ lines: ['Nothing was written.'], aside: null });
    return EXIT.ok;
  }
  const approvedReplacements = await approveReplacements(steps, { io, yes: options.yes });
  enterStep({ io, steps: wizard, step: 'install', answers });
  const results = await applyWithProgress({ io, steps, doc, approvedReplacements });
  await screen.leave();
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
