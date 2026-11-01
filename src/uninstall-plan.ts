/**
 * The reverse of `plan.ts`: turns the setup document and the user's choice
 * into steps that take away exactly what an install adds. Planning reads
 * files and writes nothing, so the whole plan, including "not set up" and
 * "left in place", is known before anything changes.
 *
 * What it removes, per harness:
 *  - a JSON or TOML entry: only the `agentbuffs` entry at the path install writes;
 *  - a harness CLI's server: the CLI's own remove command, from `run-action.ts`;
 *  - the skill: `find-agent-tools/SKILL.md`, only when it is byte for byte the
 *    skill the server serves now, and then its folder if that is empty;
 *  - anything set up by hand: the steps to undo it.
 */
import path from 'node:path';
import { findOnPath } from './detect.ts';
import { MergeRefusedError, type RemoveOutcome } from './data.ts';
import { readTextIfExists } from './file-io.ts';
import { sha256Hex } from './network.ts';
import { removeJson } from './json-merge.ts';
import { PathRefusedError, displayPath, resolveWriteTarget, templateFor, type RunContext } from './paths.ts';
import { isJsonc, type Part, type Step, type StepPlan } from './plan.ts';
import { listNames } from './render.ts';
import { RunRefusedError, assertRunAllowed, commandLine, removeArgsFor } from './run-action.ts';
import type { Action, FileAction, Harness, JsonMergeAction, RunAction, SetupDocument, TomlMergeAction } from './setup-document.ts';
import { removeToml } from './toml-merge.ts';

const SKILL_FILE_NAME = 'SKILL.md';
const PARTS: readonly Part[] = ['mcp', 'skill'];

export type RemovalInput = { doc: SetupDocument; ctx: RunContext };

type SkillDecision = { plan: StepPlan; harness: Harness };

type Context = { harness: Harness; input: RemovalInput; selected: readonly Harness[]; skillDecisions: Map<string, SkillDecision> };

function fromRemoval(opts: { outcome: RemoveOutcome; file: string; original: string | null; keyPath: readonly string[] }): StepPlan {
  if (opts.outcome.change === 'none') return { kind: 'already', file: opts.file };
  return { kind: 'write', file: opts.file, original: opts.original, text: opts.outcome.text, change: 'remove', preview: [opts.keyPath.join('.')] };
}

/** Runs a removal, naming the file in a refusal. */
function removeOrRefuse(opts: { file: string; ctx: RunContext; remove: () => RemoveOutcome }): RemoveOutcome {
  try {
    return opts.remove();
  } catch (error) {
    if (!(error instanceof MergeRefusedError)) throw error;
    throw new MergeRefusedError(`${displayPath(opts.file, opts.ctx)} was not changed: ${error.message}`);
  }
}

function planJsonRemoval(action: JsonMergeAction, context: Context): StepPlan {
  const { harness, input } = context;
  const file = resolveWriteTarget(action, input.ctx);
  const original = readTextIfExists(file);
  const isJsoncFile = isJsonc({ action, harness, file });
  const outcome = removeOrRefuse({ file, ctx: input.ctx, remove: () => removeJson({ text: original, keyPath: action.keyPath, isJsonc: isJsoncFile }) });
  return fromRemoval({ outcome, file, original, keyPath: action.keyPath });
}

function planTomlRemoval(action: TomlMergeAction, context: Context): StepPlan {
  const file = resolveWriteTarget(action, context.input.ctx);
  const original = readTextIfExists(file);
  const outcome = removeOrRefuse({ file, ctx: context.input.ctx, remove: () => removeToml({ text: original, keyPath: action.keyPath }) });
  return fromRemoval({ outcome, file, original, keyPath: action.keyPath });
}

function planRunRemoval(action: RunAction, context: Context): StepPlan {
  const { harness, input } = context;
  assertRunAllowed(action, input.doc.mcpUrl);
  const args = removeArgsFor(action, input.doc.serverName);
  if (args === null) {
    return { kind: 'manual', lines: [`This version has no remove command for ${action.command}. Remove the ${input.doc.serverName} MCP server from ${harness.name} by hand.`] };
  }
  const commandPath = findOnPath(action.command, input.ctx);
  if (commandPath === null) return { kind: 'refused', reason: `${action.command} not found on PATH` };
  const removal: RunAction = { kind: 'run', command: action.command, args };
  if (input.ctx.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath)) {
    return { kind: 'manual', lines: [`Run this yourself: ${commandLine(removal)}`] };
  }
  return { kind: 'run-remove', action: removal, commandPath };
}

/** The `name:` line of the `---` block at the top of a skill file, or null. */
export function frontmatterName(text: string): string | null {
  const block = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return null;
  const value = /^name:[ \t]*(.+?)[ \t]*$/m.exec(block)?.[1];
  if (value === undefined) return null;
  return value.replace(/^(["'])(.*)\1$/, '$2');
}

/** The skill file this harness would get, or null when the harness has none or the path is refused. Never throws. */
function skillFileOf(harness: Harness, ctx: RunContext): string | null {
  if (harness.skill?.kind !== 'file') return null;
  try {
    return resolveWriteTarget(harness.skill, ctx);
  } catch (error) {
    if (error instanceof PathRefusedError) return null;
    throw error;
  }
}

/** A note for the harnesses that keep reading a shared skill file this run deletes. */
function sharedNote(opts: { file: string; context: Context }): string | null {
  const { context } = opts;
  const others = context.input.doc.harnesses.filter(
    (harness) => !context.selected.includes(harness) && skillFileOf(harness, context.input.ctx) === opts.file,
  );
  if (others.length === 0) return null;
  return `also used by ${listNames(others.map((harness) => harness.name))}, which you did not pick`;
}

function decideSkillFile(opts: { file: string; context: Context }): StepPlan {
  const { file, context } = opts;
  const { doc, ctx } = context.input;
  const skill = doc.skill;
  if (skill === null) return { kind: 'not-offered' };
  const shown = displayPath(file, ctx);
  if (path.basename(file) !== SKILL_FILE_NAME) return { kind: 'refused', reason: `${shown} is not a ${SKILL_FILE_NAME} file` };
  const text = readTextIfExists(file);
  if (text === null) return { kind: 'already', file };
  if (frontmatterName(text) !== skill.name) return { kind: 'kept', reason: `not the ${skill.name} skill, left in place: ${shown}` };
  if (sha256Hex(text) !== skill.sha256) return { kind: 'kept', reason: `edited or outdated, left in place: ${shown}` };
  const folder = path.dirname(file);
  return { kind: 'delete', file, folder: path.basename(folder) === skill.name ? folder : null, note: sharedNote({ file, context }) };
}

/** Plans one skill file once: a second harness that shares the file gets the first one's decision. */
function planSkillRemoval(action: FileAction, context: Context): StepPlan {
  const file = resolveWriteTarget(action, context.input.ctx);
  const earlier = context.skillDecisions.get(file);
  if (earlier === undefined) {
    const plan = decideSkillFile({ file, context });
    context.skillDecisions.set(file, { plan, harness: context.harness });
    return plan;
  }
  if (earlier.plan.kind !== 'delete') return earlier.plan;
  return { ...earlier.plan, note: `same file as ${earlier.harness.name}, deleted once` };
}

/** What to do by hand for a client that the document sets up with steps. */
function manualRemovalLines(opts: { harness: Harness; steps: readonly string[]; docsUrl: string | null; what: string }): string[] {
  const head = `Delete the ${opts.what} from ${opts.harness.name}, where you added it. The steps that added it:`;
  return [head, ...opts.steps.map((step) => `  ${step}`), ...(opts.docsUrl === null ? [] : [`Docs: ${opts.docsUrl}`])];
}

function planMcpRemoval(action: Action, context: Context): StepPlan {
  switch (action.kind) {
    case 'run':
      return planRunRemoval(action, context);
    case 'json-merge':
      return planJsonRemoval(action, context);
    case 'toml-merge':
      return planTomlRemoval(action, context);
    case 'yaml-merge': {
      const where = templateFor(action, context.input.ctx.platform);
      const parent = action.keyPath.slice(0, -1).join('.');
      return { kind: 'manual', lines: [`Delete the ${action.keyPath.at(-1) ?? ''} entry under ${parent} in ${where}.`] };
    }
    case 'manual':
      return { kind: 'manual', lines: manualRemovalLines({ harness: context.harness, steps: action.steps, docsUrl: action.docsUrl, what: `${context.input.doc.serverName} server` }) };
    case 'file':
      return { kind: 'refused', reason: 'a file action only applies to the skill' };
    case 'unsupported':
      return { kind: 'manual', lines: [`This version cannot undo "${action.originalKind}" yet. Update agentbuffs: npx agentbuffs@latest`] };
  }
}

function planSkillPart(action: Action, context: Context): StepPlan {
  switch (action.kind) {
    case 'file':
      return planSkillRemoval(action, context);
    case 'manual':
      return { kind: 'manual', lines: manualRemovalLines({ harness: context.harness, steps: action.steps, docsUrl: action.docsUrl, what: 'skill' }) };
    case 'unsupported':
      return { kind: 'manual', lines: [`This version cannot undo "${action.originalKind}" yet. Update agentbuffs: npx agentbuffs@latest`] };
    case 'run':
    case 'json-merge':
    case 'toml-merge':
    case 'yaml-merge':
      return { kind: 'refused', reason: `a ${action.kind} action cannot be undone for the skill` };
  }
}

function isRefusal(error: unknown): error is Error {
  return error instanceof MergeRefusedError || error instanceof PathRefusedError || error instanceof RunRefusedError;
}

function planStep(part: Part, context: Context): Step {
  const { harness } = context;
  const action = harness[part];
  if (action === null) return { harness, part, plan: { kind: 'not-offered' } };
  try {
    return { harness, part, plan: part === 'mcp' ? planMcpRemoval(action, context) : planSkillPart(action, context) };
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return { harness, part, plan: { kind: 'refused', reason: error.message } };
  }
}

/** One step per selected harness and part, in the order given. */
export function buildRemovalPlan(opts: { harnesses: readonly Harness[]; input: RemovalInput }): Step[] {
  const skillDecisions = new Map<string, SkillDecision>();
  return opts.harnesses.flatMap((harness) =>
    PARTS.map((part) => planStep(part, { harness, input: opts.input, selected: opts.harnesses, skillDecisions })),
  );
}
