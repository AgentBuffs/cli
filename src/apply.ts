/**
 * Carries out the planned steps. Every question was asked before this runs,
 * so a cancel can never leave half a plan applied.
 */
import { backupFile, readTextIfExists, writeAtomic } from './file-io.ts';
import { displayPath, type RunContext } from './paths.ts';
import type { Step, WriteChange } from './plan.ts';
import { INSTALLED_CHECKS, failureText, mentionsUrl, type ExecFn } from './run-action.ts';
import type { RunAction, SetupDocument } from './setup-document.ts';
import { applyDelete, applyRunRemoval } from './uninstall-apply.ts';

export type ResultStatus = 'done' | 'already' | 'skipped' | 'failed' | 'manual' | 'not-offered';
/** `detail` says what happened in a few words; `backup` is the copy made before a write, if any. */
export type StepResult = { step: Step; status: ResultStatus; detail: string; backup: string | null };

export type ApplyInput = {
  doc: SetupDocument;
  ctx: RunContext;
  exec: ExecFn;
  /** Steps whose different existing entry the user agreed to replace (or `--yes`). */
  approvedReplacements: ReadonlySet<Step>;
  /** Files an uninstall deleted so far in this run, shared across the calls for each harness. */
  removedFiles: Set<string>;
};

const WRITE_VERB: Readonly<Record<WriteChange, string>> = { create: 'wrote', add: 'wrote', replace: 'replaced the entry in', remove: 'removed the entry in' };

function applyWrite(step: Step, plan: Extract<Step['plan'], { kind: 'write' }>, input: ApplyInput): StepResult {
  const shown = displayPath(plan.file, input.ctx);
  if (plan.change === 'replace' && !input.approvedReplacements.has(step)) {
    return { step, status: 'skipped', detail: `kept the existing entry in ${shown}`, backup: null };
  }
  const current = readTextIfExists(plan.file);
  // Several harnesses can share one file (the skill in ~/.agents/skills): an earlier step already wrote it.
  if (current === plan.text) return { step, status: 'already', detail: plan.change === 'remove' ? 'not set up' : 'already there', backup: null };
  if (current !== plan.original) {
    return { step, status: 'failed', detail: `${shown} changed while this ran, run agentbuffs again`, backup: null };
  }
  const backup = plan.original === null ? null : backupFile(plan.file);
  writeAtomic({ file: plan.file, text: plan.text });
  const verb = WRITE_VERB[plan.change];
  return { step, status: 'done', detail: `${verb} ${shown}`, backup };
}

async function applyRun(opts: { step: Step; action: RunAction; commandPath: string; input: ApplyInput }): Promise<StepResult> {
  const { step, action, commandPath, input } = opts;
  const checkArgs = INSTALLED_CHECKS[action.command]?.(input.doc.serverName);
  if (checkArgs !== undefined) {
    const check = await input.exec({ file: commandPath, args: checkArgs });
    if (check.exitCode === 0 && mentionsUrl(check.stdout, input.doc.mcpUrl)) return { step, status: 'already', detail: 'already there', backup: null };
    if (check.exitCode === 0) {
      const remove = `${action.command} mcp remove ${input.doc.serverName}`;
      return { step, status: 'skipped', detail: `a different ${input.doc.serverName} entry is there, run \`${remove}\` and try again`, backup: null };
    }
  }
  const result = await input.exec({ file: commandPath, args: action.args });
  if (result.exitCode !== 0) return { step, status: 'failed', detail: `${action.command} failed, ${failureText(result)}`, backup: null };
  return { step, status: 'done', detail: `ran ${action.command} ${action.args.slice(0, 2).join(' ')}`, backup: null };
}

async function applyStep(step: Step, input: ApplyInput): Promise<StepResult> {
  const { plan } = step;
  switch (plan.kind) {
    case 'write':
      return applyWrite(step, plan, input);
    case 'run':
      return applyRun({ step, action: plan.action, commandPath: plan.commandPath, input });
    case 'run-remove':
      return applyRunRemoval({ step, plan, input });
    case 'delete':
      return applyDelete({ step, plan, input });
    case 'kept':
      return { step, status: 'skipped', detail: plan.reason, backup: null };
    case 'already':
      return { step, status: 'already', detail: 'already there', backup: null };
    case 'manual':
      return { step, status: 'manual', detail: 'manual steps', backup: null };
    case 'refused':
      return { step, status: 'failed', detail: plan.reason, backup: null };
    case 'not-offered':
      return { step, status: 'not-offered', detail: 'not offered for this agent', backup: null };
  }
}

/** Applies the steps one after another. A write error stops nothing else: it becomes that step's result. */
export async function applyPlan(steps: readonly Step[], input: ApplyInput): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    try {
      results.push(await applyStep(step, input));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({ step, status: 'failed', detail: reason, backup: null });
    }
  }
  return results;
}
