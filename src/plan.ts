/**
 * Turns the setup document and the user's choice into steps. Planning reads
 * files but writes nothing, so the full plan, including "already there" and
 * refusals, is known before anything changes.
 */
import { findOnPath } from './detect.ts';
import { MergeRefusedError, type MergeOutcome } from './data.ts';
import { readTextIfExists } from './file-io.ts';
import { mergeJson } from './json-merge.ts';
import { PathRefusedError, displayPath, resolveWriteTarget, templateFor, type RunContext } from './paths.ts';
import { RunRefusedError, assertRunAllowed, commandLine } from './run-action.ts';
import type { Action, FileAction, Harness, JsonMergeAction, RunAction, SetupDocument, TomlMergeAction } from './setup-document.ts';
import { mergeToml, renderTomlTable } from './toml-merge.ts';
import { yamlSnippet } from './yaml-snippet.ts';

export type Part = 'mcp' | 'skill';
export type What = 'mcp' | 'skill' | 'both';

export const PARTS_FOR: Readonly<Record<What, readonly Part[]>> = { mcp: ['mcp'], skill: ['skill'], both: ['mcp', 'skill'] };

/** Harnesses whose config files are JSONC (comments and trailing commas allowed). */
const JSONC_HARNESSES: ReadonlySet<string> = new Set(['vscode', 'zed', 'kilo-code']);

export type WriteChange = 'create' | 'add' | 'replace';

export type StepPlan =
  | { kind: 'write'; file: string; original: string | null; text: string; change: WriteChange; preview: string[] }
  | { kind: 'already'; file: string }
  | { kind: 'run'; action: RunAction; commandPath: string }
  | { kind: 'manual'; lines: string[] }
  | { kind: 'refused'; reason: string }
  | { kind: 'not-offered' };

export type Step = { harness: Harness; part: Part; plan: StepPlan };

/** The skill text, downloaded and checked once per run, or why it is not available. */
export type SkillText = { ok: true; text: string } | { ok: false; reason: string } | null;

type PlanInput = { doc: SetupDocument; ctx: RunContext; skillText: SkillText };

function fromMerge(opts: { outcome: MergeOutcome; file: string; original: string | null; preview: string[] }): StepPlan {
  if (opts.outcome.change === 'none') return { kind: 'already', file: opts.file };
  return { kind: 'write', file: opts.file, original: opts.original, text: opts.outcome.text, change: opts.outcome.change, preview: opts.preview };
}

function isJsonc(opts: { action: JsonMergeAction; harness: Harness; file: string }): boolean {
  if (opts.action.jsonc !== null) return opts.action.jsonc;
  return opts.file.endsWith('.jsonc') || JSONC_HARNESSES.has(opts.harness.slug);
}

/** Runs a merge, naming the file in a refusal. */
function mergeOrRefuse(opts: { file: string; ctx: RunContext; merge: () => MergeOutcome }): MergeOutcome {
  try {
    return opts.merge();
  } catch (error) {
    if (!(error instanceof MergeRefusedError)) throw error;
    throw new MergeRefusedError(`${displayPath(opts.file, opts.ctx)} was not changed: ${error.message}`);
  }
}

function planJsonMerge(action: JsonMergeAction, harness: Harness, input: PlanInput): StepPlan {
  const file = resolveWriteTarget(templateFor(action, input.ctx.platform), input.ctx);
  const original = readTextIfExists(file);
  const jsonc = isJsonc({ action, harness, file });
  const outcome = mergeOrRefuse({
    file,
    ctx: input.ctx,
    merge: () => mergeJson({ text: original, keyPath: action.keyPath, value: action.value, isJsonc: jsonc }),
  });
  const preview = [`${action.keyPath.join('.')} = ${JSON.stringify(action.value)}`];
  return fromMerge({ outcome, file, original, preview });
}

function planTomlMerge(action: TomlMergeAction, input: PlanInput): StepPlan {
  const file = resolveWriteTarget(templateFor(action, input.ctx.platform), input.ctx);
  const original = readTextIfExists(file);
  const outcome = mergeOrRefuse({
    file,
    ctx: input.ctx,
    merge: () => mergeToml({ text: original, keyPath: action.keyPath, value: action.value }),
  });
  const preview = renderTomlTable({ keyPath: action.keyPath, value: action.value, eol: '\n' }).trimEnd().split('\n');
  return fromMerge({ outcome, file, original, preview });
}

function planRun(action: RunAction, input: PlanInput): StepPlan {
  assertRunAllowed(action, input.doc.mcpUrl);
  const commandPath = findOnPath(action.command, input.ctx);
  if (commandPath === null) return { kind: 'refused', reason: `${action.command} is not on your PATH` };
  if (input.ctx.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath)) {
    return { kind: 'manual', lines: [`Run this yourself: ${commandLine(action)}`] };
  }
  return { kind: 'run', action, commandPath };
}

function planSkillFile(action: FileAction, input: PlanInput): StepPlan {
  const skill = input.doc.skill;
  if (skill === null || input.skillText === null) return { kind: 'not-offered' };
  if (!input.skillText.ok) return { kind: 'refused', reason: input.skillText.reason };
  const file = resolveWriteTarget(templateFor(action, input.ctx.platform), input.ctx);
  const original = readTextIfExists(file);
  if (original === input.skillText.text) return { kind: 'already', file };
  const change: WriteChange = original === null ? 'create' : 'replace';
  const preview = [`the ${skill.name} skill, ${Buffer.byteLength(input.skillText.text)} bytes, sha256 ${skill.sha256.slice(0, 12)}`];
  return { kind: 'write', file, original, text: input.skillText.text, change, preview };
}

function manualLines(steps: readonly string[], docsUrl: string | null): string[] {
  return docsUrl === null ? [...steps] : [...steps, `Docs: ${docsUrl}`];
}

function planAction(opts: { action: Action; harness: Harness; part: Part; input: PlanInput }): StepPlan {
  const { action, harness, input } = opts;
  switch (action.kind) {
    case 'run':
      return planRun(action, input);
    case 'json-merge':
      return planJsonMerge(action, harness, input);
    case 'toml-merge':
      return planTomlMerge(action, input);
    case 'yaml-merge': {
      const where = templateFor(action, input.ctx.platform);
      return { kind: 'manual', lines: [`Add this to ${where}:`, ...yamlSnippet(action.keyPath, action.value).split('\n')] };
    }
    case 'file':
      if (opts.part !== 'skill') return { kind: 'refused', reason: 'a file action only applies to the skill' };
      return planSkillFile(action, input);
    case 'manual':
      return { kind: 'manual', lines: manualLines(action.steps, action.docsUrl) };
    case 'unsupported':
      return { kind: 'manual', lines: [`This version cannot do "${action.originalKind}" yet. Update agentbuffs: npx agentbuffs@latest`] };
  }
}

function isRefusal(error: unknown): error is Error {
  return error instanceof MergeRefusedError || error instanceof PathRefusedError || error instanceof RunRefusedError;
}

function planStep(opts: { harness: Harness; part: Part; input: PlanInput }): Step {
  const action = opts.harness[opts.part];
  if (action === null) return { harness: opts.harness, part: opts.part, plan: { kind: 'not-offered' } };
  try {
    return { harness: opts.harness, part: opts.part, plan: planAction({ action, harness: opts.harness, part: opts.part, input: opts.input }) };
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return { harness: opts.harness, part: opts.part, plan: { kind: 'refused', reason: error.message } };
  }
}

/** One step per selected harness and part, in the order given. */
export function buildPlan(opts: { harnesses: readonly Harness[]; what: What; input: PlanInput }): Step[] {
  const parts = PARTS_FOR[opts.what];
  return opts.harnesses.flatMap((harness) => parts.map((part) => planStep({ harness, part, input: opts.input })));
}

/** True when a step would write a file or run a program. */
export function isActionable(step: Step): boolean {
  return step.plan.kind === 'write' || step.plan.kind === 'run';
}
