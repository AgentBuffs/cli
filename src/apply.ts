/**
 * Carries out the planned steps. Every question was asked before this runs,
 * so a cancel can never leave half a plan applied.
 */
import { backupFile, readTextIfExists, writeAtomic } from './file-io.ts';
import { displayPath, type RunContext } from './paths.ts';
import type { Step } from './plan.ts';
import { INSTALLED_CHECKS, failureText, type ExecFn } from './run-action.ts';
import type { RunAction, SetupDocument } from './setup-document.ts';

export type ResultStatus = 'done' | 'already' | 'skipped' | 'failed' | 'manual' | 'not-offered';
export type StepResult = { step: Step; status: ResultStatus; detail: string };

export type ApplyInput = {
  doc: SetupDocument;
  ctx: RunContext;
  exec: ExecFn;
  /** Steps whose different existing entry the user agreed to replace (or `--yes`). */
  approvedReplacements: ReadonlySet<Step>;
};

function applyWrite(step: Step, plan: Extract<Step['plan'], { kind: 'write' }>, input: ApplyInput): StepResult {
  const shown = displayPath(plan.file, input.ctx);
  if (plan.change === 'replace' && !input.approvedReplacements.has(step)) {
    return { step, status: 'skipped', detail: `kept the existing entry in ${shown}` };
  }
  const current = readTextIfExists(plan.file);
  // Several harnesses can share one file (the skill in ~/.agents/skills): an earlier step already wrote it.
  if (current === plan.text) return { step, status: 'already', detail: 'already there' };
  if (current !== plan.original) {
    return { step, status: 'failed', detail: `${shown} changed while this ran; run agentbuffs again` };
  }
  const backup = plan.original === null ? null : backupFile(plan.file);
  writeAtomic({ file: plan.file, text: plan.text });
  const backupNote = backup === null ? '' : `, backup ${displayPath(backup, input.ctx)}`;
  const verb = plan.change === 'replace' ? 'replaced the existing entry in' : 'wrote';
  return { step, status: 'done', detail: `${verb} ${shown}${backupNote}` };
}

async function applyRun(opts: { step: Step; action: RunAction; commandPath: string; input: ApplyInput }): Promise<StepResult> {
  const { step, action, commandPath, input } = opts;
  const checkArgs = INSTALLED_CHECKS[action.command]?.(input.doc.serverName);
  if (checkArgs !== undefined) {
    const check = await input.exec({ file: commandPath, args: checkArgs });
    if (check.exitCode === 0 && check.stdout.includes(input.doc.mcpUrl)) return { step, status: 'already', detail: 'already there' };
    if (check.exitCode === 0) {
      const remove = `${action.command} mcp remove ${input.doc.serverName}`;
      return { step, status: 'skipped', detail: `a different "${input.doc.serverName}" entry exists; run \`${remove}\`, then run agentbuffs again` };
    }
  }
  const result = await input.exec({ file: commandPath, args: action.args });
  if (result.exitCode !== 0) return { step, status: 'failed', detail: `${action.command} said: ${failureText(result)}` };
  return { step, status: 'done', detail: `ran ${action.command} ${action.args.slice(0, 2).join(' ')}` };
}

async function applyStep(step: Step, input: ApplyInput): Promise<StepResult> {
  const { plan } = step;
  switch (plan.kind) {
    case 'write':
      return applyWrite(step, plan, input);
    case 'run':
      return applyRun({ step, action: plan.action, commandPath: plan.commandPath, input });
    case 'already':
      return { step, status: 'already', detail: 'already there' };
    case 'manual':
      return { step, status: 'manual', detail: 'follow the steps in the plan' };
    case 'refused':
      return { step, status: 'failed', detail: plan.reason };
    case 'not-offered':
      return { step, status: 'not-offered', detail: 'not offered for this harness' };
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
      results.push({ step, status: 'failed', detail: reason });
    }
  }
  return results;
}
