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
import { PARTS_FOR, buildPlan, isActionable, type Command, type SkillText, type Step, type What } from './plan.ts';
import { CancelledError, type DetailsOffer, type HarnessChoice, type Prompter } from './prompts.ts';
import { PART_CHOICE, agentSlugLines, backupLine, closing, detailLines, listNames, manualLines, planLines, resultLines } from './render.ts';
import type { Screen } from './screen.ts';
import type { ExecFn } from './run-action.ts';
import { SetupDocumentError, UnsupportedSetupVersionError, type Harness, type SetupDocument } from './setup-document.ts';
import { buildRemovalPlan } from './uninstall-plan.ts';
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
The uninstall command removes them again.

Usage
  npx agentbuffs [options]
  npx agentbuffs uninstall [options]

Options
  --client <slugs>   Agents to set up, comma separated, for example
                     opencode or claude-code,codex. Without a terminal,
                     --dry-run alone lists every agent and its slug.
  --what <part>      mcp, skill or both (install only)
  -y, --yes          Install or remove without asking
  --dry-run          Show every change and write nothing
  --no-reports       Set up without the rating tools. With uninstall,
                     use it to remove an install that used it.
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
  command: Command;
  clients: string[] | null;
  what: What | null;
  yes: boolean;
  dryRun: boolean;
  /** `--no-reports`: ask the server for the setup without the rating tools. */
  noReports: boolean;
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

/** The command the arguments name: none or `install` installs, `uninstall` removes. */
function commandOf(positionals: readonly string[]): Command {
  const [first, ...rest] = positionals;
  if (first === undefined) return 'install';
  if (rest.length === 0 && (first === 'install' || first === 'uninstall')) return first;
  throw new UsageError(`Unknown command "${positionals.join(' ')}". The commands are install (the default) and uninstall`);
}

/** The options in `argv`. Throws `UsageError` on an unknown flag or a bad value. */
export function readOptions(argv: readonly string[]): Options {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: true,
        options: {
          client: { type: 'string' },
          what: { type: 'string' },
          yes: { type: 'boolean', short: 'y' },
          'dry-run': { type: 'boolean' },
          'no-reports': { type: 'boolean' },
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
  const command = commandOf(parsed.positionals);
  if (command === 'uninstall' && values.what !== undefined) throw new UsageError('--what is for install. Uninstall removes the MCP server and the skill together.');
  if (values.what !== undefined && !isWhat(values.what)) throw new UsageError(`--what must be mcp, skill or both, not "${values.what}"`);
  const clients = values.client === undefined ? null : values.client.split(',').map((slug) => slug.trim()).filter(Boolean);
  if (clients !== null && clients.length === 0) throw new UsageError('--client needs at least one slug');
  return {
    command,
    clients,
    what: values.what ?? null,
    yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false,
    noReports: values['no-reports'] ?? false,
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
  if (!io.isInteractive || options.yes) return doc.harnesses.filter((harness) => found.has(harness.slug));
  const ordered = [...doc.harnesses.filter((h) => found.has(h.slug)), ...doc.harnesses.filter((h) => !found.has(h.slug))];
  const choices: HarnessChoice[] = ordered.map((harness) => ({ slug: harness.slug, label: harness.name, hint: found.has(harness.slug) ? 'found' : null }));
  const picked = await io.prompter.chooseHarnesses({ choices, preselected: [...found], command: options.command });
  return harnessesBySlug(doc, picked);
}

/** The answer to "what should they get" when nobody is asked, or null when the question is asked. `--yes` never asks. */
function whatWithoutAsking(opts: { doc: SetupDocument; harnesses: readonly Harness[]; io: CliIo; options: Options }): What | null {
  if (opts.options.what !== null) return opts.options.what;
  const anySkill = opts.doc.skill !== null && opts.harnesses.some((harness) => harness.skill !== null);
  if (!anySkill || opts.options.yes || !opts.io.isInteractive) return anySkill ? 'both' : 'mcp';
  return null;
}

/** The message for a run that needs an agent and found none. */
function noAgentFound(doc: SetupDocument): string {
  return `No agent found. Pick one with --client: ${doc.harnesses.map((harness) => harness.slug).join(', ')}`;
}

/**
 * The wizard's steps for this run: the agent list only without --client, the
 * parts question only for an install without --what and when the setup offers a skill. With
 * --yes neither is asked (and the run is not full screen). The
 * parts step can still be answered without a question (no picked agent takes
 * a skill); it then counts as done.
 */
function wizardSteps(opts: { doc: SetupDocument; options: Options }): WizardStep[] {
  return [
    ...(opts.options.clients === null && !opts.options.yes ? (['agents'] as const) : []),
    ...(opts.options.command === 'install' && opts.options.what === null && !opts.options.yes && opts.doc.skill !== null ? (['parts'] as const) : []),
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
async function confirmPlan(opts: { io: CliIo; command: Command; showPage: (page: number) => void; pages: number; shownPages: number }): Promise<boolean> {
  let nextPage = opts.shownPages;
  for (let round = 0; round <= opts.pages; round += 1) {
    const action = await opts.io.prompter.choosePlanAction({ details: detailsOffer({ nextPage, pages: opts.pages }), command: opts.command });
    if (action === 'install') return true;
    if (action === 'cancel') return false;
    if (nextPage >= opts.pages) throw new Error('No more changes to show');
    opts.showPage(nextPage);
    nextPage += 1;
  }
  throw new Error('The plan question was asked more often than there are pages');
}

/** The words that differ between an install and an uninstall. */
const WORDS: Readonly<Record<Command, { working: string; setting: (name: string) => string; goAhead: string; nothing: string; byHand: string }>> = {
  install: { working: 'Installing', setting: (name) => `Setting up ${name}`, goAhead: 'install', nothing: 'Nothing was written.', byHand: 'Set up by hand' },
  uninstall: { working: 'Removing', setting: (name) => `Removing ${name}`, goAhead: 'remove', nothing: 'Nothing was removed.', byHand: 'Remove by hand' },
};

/** Applies the plan one harness at a time, under a spinner that names it, with each finished harness's line above it. */
async function applyWithProgress(opts: {
  io: CliIo;
  command: Command;
  steps: readonly Step[];
  doc: SetupDocument;
  approvedReplacements: ReadonlySet<Step>;
}): Promise<StepResult[]> {
  const { io, command } = opts;
  const removedFiles = new Set<string>();
  const harnesses = [...new Set(opts.steps.map((step) => step.harness))];
  const names = harnesses.map((harness) => harness.name);
  const spinner = io.screen.spinner(WORDS[command].working);
  const results: StepResult[] = [];
  for (const harness of harnesses) {
    spinner.message(WORDS[command].setting(harness.name));
    const steps = opts.steps.filter((step) => step.harness === harness);
    results.push(...(await applyPlan(steps, { doc: opts.doc, ctx: io.ctx, exec: io.exec, approvedReplacements: opts.approvedReplacements, removedFiles })));
    spinner.progress(resultLines({ results, paint: io.screen.paint, command, names }));
  }
  const isOk = !hasFailure(results);
  spinner.stop({ text: isOk ? 'Done' : 'Done, with problems', isOk });
  return results;
}

function showResults(opts: { io: CliIo; command: Command; hasReports: boolean; steps: readonly Step[]; results: readonly StepResult[] }): void {
  const { io } = opts;
  const { paint } = io.screen;
  io.screen.list(resultLines({ results: opts.results, paint, command: opts.command }));
  const manual = manualLines({ steps: opts.steps, paint, width: io.screen.width });
  if (manual.length > 0) io.screen.section({ title: WORDS[opts.command].byHand, lines: manual });
  const backups = backupLine({ results: opts.results, ctx: io.ctx });
  if (backups !== null) io.screen.aside(backups);
  io.screen.end(closing({ results: opts.results, command: opts.command, hasReports: opts.hasReports }));
}

type Planned = { steps: Step[]; answers: Answer[] };

/** Asks the parts question if needed, gets the skill, and plans what an install adds. */
async function planInstall(opts: {
  doc: SetupDocument;
  harnesses: readonly Harness[];
  io: CliIo;
  options: Options;
  agentsAnswer: Answer;
  wizard: readonly WizardStep[];
}): Promise<Planned> {
  const { doc, harnesses, io, options, agentsAnswer, wizard } = opts;
  const decidedWhat = whatWithoutAsking({ doc, harnesses, io, options });
  if (decidedWhat === null) enterStep({ io, steps: wizard, step: 'parts', answers: [agentsAnswer] });
  const what = decidedWhat ?? (await io.prompter.chooseWhat());
  const answers: Answer[] = [agentsAnswer, { label: 'Parts', value: PART_CHOICE[what] }];
  enterStep({ io, steps: wizard, step: 'plan', answers });
  const skillText = await withSpinner({ io, text: 'Getting the skill', work: () => loadSkillText({ doc, harnesses, what, options, io }) });
  return { steps: buildPlan({ harnesses, what, input: { doc, ctx: io.ctx, skillText } }), answers };
}

/** Plans what an uninstall takes away. It needs no skill download: the document's checksum says which file is ours. */
function planUninstall(opts: { doc: SetupDocument; harnesses: readonly Harness[]; io: CliIo; answers: Answer[]; wizard: readonly WizardStep[] }): Planned {
  const { doc, harnesses, io, answers, wizard } = opts;
  enterStep({ io, steps: wizard, step: 'plan', answers });
  return { steps: buildRemovalPlan({ harnesses, input: { doc, ctx: io.ctx } }), answers };
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
  const { command } = options;
  screen.start(io.version);
  const doc = await withSpinner({
    io,
    text: 'Getting the list of agents',
    work: () => fetchSetupDocument({ api: options.api, version: io.version, reportsOff: options.noReports }),
  });
  const found = new Set(doc.harnesses.filter((harness) => isHarnessPresent(harness, io.ctx)).map((harness) => harness.slug));
  const wizard = wizardSteps({ doc, options });
  enterStep({ io, steps: wizard, step: 'agents', answers: [] });
  const harnesses = await chooseHarnesses({ doc, found, io, options });
  if (io.isInteractive && options.yes && options.clients === null && harnesses.length === 0) {
    screen.fail(noAgentFound(doc));
    return EXIT.usage;
  }
  const agentsAnswer: Answer = { label: 'Agents', value: harnesses.length === 0 ? 'none' : listNames(harnesses.map((harness) => harness.name)) };
  const { steps, answers } =
    command === 'uninstall'
      ? planUninstall({ doc, harnesses, io, answers: [agentsAnswer], wizard })
      : await planInstall({ doc, harnesses, io, options, agentsAnswer, wizard });
  const reportsLines = command === 'install' && options.noReports ? ['', 'Reports: off'] : [];
  const plan = { title: 'Plan', lines: steps.length === 0 ? ['nothing selected'] : [...planLines(steps, command), ...reportsLines] };
  const changes = detailLines({ steps, ctx: io.ctx, paint: screen.paint, width: screen.width, command });
  const pages = toPages(changes, screen.pageRows());
  const showPage = (page: number): void =>
    screen.section({ title: pages.length === 1 ? 'Changes' : `Changes, page ${page + 1} of ${pages.length}`, lines: pages[page] ?? [] });

  if (!io.isInteractive && !options.dryRun && (options.clients === null || !options.yes)) {
    screen.note(plan);
    const noneFound = options.clients === null && harnesses.length === 0 ? 'No agent found.\n' : '';
    const agents = options.clients === null ? `\nAgents you can pass to --client:\n${agentSlugLines(doc.harnesses).join('\n')}` : '';
    screen.fail(`${noneFound}No terminal to ask in. Run again with --client <slug,...> --yes to ${WORDS[command].goAhead}, or add --dry-run to see every change.${agents}`);
    return EXIT.usage;
  }
  if (options.dryRun) {
    // A dry run's plan and changes are its result: they belong in the scrollback.
    await screen.leave();
    screen.note(plan);
    screen.section({ title: 'Changes', lines: changes });
    const manual = manualLines({ steps, paint: screen.paint, width: screen.width });
    if (manual.length > 0) screen.section({ title: WORDS[command].byHand, lines: manual });
    // Without a terminal and without --client, the plan covers only the agents found; this is where an agent learns the rest.
    if (!io.isInteractive && options.clients === null) screen.section({ title: 'Agents you can pass to --client', lines: agentSlugLines(doc.harnesses) });
    screen.end({ lines: ['Dry run. Nothing was written.'], aside: null });
    return EXIT.ok;
  }
  screen.note(plan);
  if (options.verbose) showPage(0);
  const shownPages = options.verbose ? 1 : 0;
  if (steps.some(isActionable) && !options.yes && !(await confirmPlan({ io, command, showPage, pages: pages.length, shownPages }))) {
    screen.end({ lines: [WORDS[command].nothing], aside: null });
    return EXIT.ok;
  }
  const approvedReplacements = await approveReplacements(steps, { io, yes: options.yes });
  enterStep({ io, steps: wizard, step: 'install', answers });
  const results = await applyWithProgress({ io, command, steps, doc, approvedReplacements });
  await screen.leave();
  showResults({ io, command, hasReports: !options.noReports, steps, results });
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
