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
import { finalHint, planText, resultText } from './render.ts';
import type { ExecFn } from './run-action.ts';
import { SetupDocumentError, UnsupportedSetupVersionError, type Harness, type SetupDocument } from './setup-document.ts';

export type CliIo = {
  argv: readonly string[];
  out: (text: string) => void;
  err: (text: string) => void;
  /** True when stdin and stdout are both terminals, so questions can be asked. */
  isInteractive: boolean;
  ctx: RunContext;
  prompter: Prompter;
  exec: ExecFn;
  version: string;
};

export const EXIT = { ok: 0, failed: 1, usage: 2, cancelled: 130 } as const;

const HELP = `agentbuffs: install the agentbuffs MCP server and skill into your agent harness.

Usage: npx agentbuffs [options]

Options:
  --client <slug,...>   Harnesses to set up, for example claude-code,cursor
  --what <part>         mcp, skill or both (default: ask, or both)
  --yes                 Do not ask; apply the plan
  --dry-run             Show the plan and write nothing
  --api <url>           Setup server (default ${DEFAULT_API})
  --version             Print the version
  --help                Print this help

Without a terminal, pass --client and --yes, or --dry-run to only see the plan.
Docs: https://agentbuffs.com  Privacy: https://agentbuffs.com/privacy`;

class UsageError extends Error {
  override name = 'UsageError';
}

type Options = {
  clients: string[] | null;
  what: What | null;
  yes: boolean;
  dryRun: boolean;
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

function harnessHint(harness: Harness, found: ReadonlySet<string>): string {
  const marks = [found.has(harness.slug) ? 'found' : 'not found'];
  if (harness.skill === null) marks.push('MCP only');
  return marks.join(', ');
}

async function chooseHarnesses(opts: { doc: SetupDocument; found: ReadonlySet<string>; io: CliIo; options: Options }): Promise<Harness[]> {
  const { doc, found, io, options } = opts;
  if (options.clients !== null) return harnessesBySlug(doc, options.clients);
  if (!io.isInteractive) return doc.harnesses.filter((harness) => found.has(harness.slug));
  const ordered = [...doc.harnesses.filter((h) => found.has(h.slug)), ...doc.harnesses.filter((h) => !found.has(h.slug))];
  const choices: HarnessChoice[] = ordered.map((harness) => ({ slug: harness.slug, label: harness.name, hint: harnessHint(harness, found) }));
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

async function run(io: CliIo): Promise<number> {
  const options = readOptions(io.argv);
  if (options.help) {
    io.out(HELP);
    return EXIT.ok;
  }
  if (options.version) {
    io.out(io.version);
    return EXIT.ok;
  }

  const doc = await fetchSetupDocument({ api: options.api, version: io.version });
  const found = new Set(doc.harnesses.filter((harness) => isHarnessPresent(harness, io.ctx)).map((harness) => harness.slug));
  const harnesses = await chooseHarnesses({ doc, found, io, options });
  const what = await chooseWhat({ doc, harnesses, io, options });
  const skillText = await loadSkillText({ doc, harnesses, what, options, io });
  const steps = buildPlan({ harnesses, what, input: { doc, ctx: io.ctx, skillText } });
  io.out(planText({ steps, ctx: io.ctx, found }));

  if (!io.isInteractive && (options.clients === null || (!options.yes && !options.dryRun))) {
    if (options.clients === null && harnesses.length === 0) io.err(`No harness found. Pick one with --client: ${doc.harnesses.map((h) => h.slug).join(', ')}`);
    io.err('No terminal to ask in. Run again with --client <slug,...> --yes to apply, or add --dry-run to only see the plan.');
    return EXIT.usage;
  }
  if (options.dryRun) {
    io.out('Dry run: nothing was written.');
    return EXIT.ok;
  }
  if (steps.some(isActionable) && !options.yes && !(await io.prompter.confirm('Apply this plan?'))) {
    io.out('Nothing was written.');
    return EXIT.ok;
  }
  const approvedReplacements = await approveReplacements(steps, { io, yes: options.yes });
  const results = await applyPlan(steps, { doc, ctx: io.ctx, exec: io.exec, approvedReplacements });
  io.out(resultText(results));
  io.out(finalHint(results));
  return hasFailure(results) ? EXIT.failed : EXIT.ok;
}

/** Runs the command and returns the exit code. Never throws for an expected problem. */
export async function main(io: CliIo): Promise<number> {
  try {
    return await run(io);
  } catch (error) {
    if (error instanceof CancelledError) {
      io.err('Cancelled. Nothing was written.');
      return EXIT.cancelled;
    }
    if (error instanceof UsageError) {
      io.err(`${error.message}\nRun agentbuffs --help for the options.`);
      return EXIT.usage;
    }
    if (error instanceof NetworkError || error instanceof SetupDocumentError || error instanceof UnsupportedSetupVersionError) {
      io.err(error.message);
      return EXIT.failed;
    }
    throw error;
  }
}
