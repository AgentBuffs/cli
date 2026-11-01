/**
 * Carries out the removal steps `uninstall-plan.ts` made. Like `apply.ts`, it
 * runs after every question was asked, and one failed step stops nothing else.
 */
import type { ApplyInput, StepResult } from './apply.ts';
import { readTextIfExists, removeDirIfEmpty, removeFile } from './file-io.ts';
import { sha256Hex } from './network.ts';
import { displayPath } from './paths.ts';
import type { Step, StepPlan } from './plan.ts';
import { INSTALLED_CHECKS, failureText } from './run-action.ts';

type RunRemoveStep = { step: Step; plan: Extract<StepPlan, { kind: 'run-remove' }>; input: ApplyInput };
type DeleteStep = { step: Step; plan: Extract<StepPlan, { kind: 'delete' }>; input: ApplyInput };

/** Runs the harness CLI's remove command, after asking the CLI whether the server is there at all. */
export async function applyRunRemoval(opts: RunRemoveStep): Promise<StepResult> {
  const { step, plan, input } = opts;
  const { action, commandPath } = plan;
  const checkArgs = INSTALLED_CHECKS[action.command]?.(input.doc.serverName);
  if (checkArgs !== undefined) {
    const check = await input.exec({ file: commandPath, args: checkArgs });
    if (check.exitCode !== 0) return { step, status: 'already', detail: 'not set up', backup: null };
  }
  const result = await input.exec({ file: commandPath, args: action.args });
  if (result.exitCode !== 0) return { step, status: 'failed', detail: `${action.command} failed, ${failureText(result)}`, backup: null };
  return { step, status: 'done', detail: `ran ${action.command} ${action.args.slice(0, 2).join(' ')}`, backup: null };
}

/**
 * Deletes the skill file, then its folder if that is empty. The file is read
 * again first: a skill edited since the plan was made stays. A file an earlier
 * step of this run already deleted (several harnesses share one) counts as done.
 */
export function applyDelete(opts: DeleteStep): StepResult {
  const { step, plan, input } = opts;
  const shown = displayPath(plan.file, input.ctx);
  const text = readTextIfExists(plan.file);
  if (text === null) {
    if (input.removedFiles.has(plan.file)) return { step, status: 'done', detail: `removed ${shown} with the first agent that shares it`, backup: null };
    return { step, status: 'already', detail: 'not set up', backup: null };
  }
  if (input.doc.skill === null || sha256Hex(text) !== input.doc.skill.sha256) {
    return { step, status: 'skipped', detail: `${shown} changed while this ran, left in place`, backup: null };
  }
  removeFile(plan.file);
  input.removedFiles.add(plan.file);
  const isFolderGone = plan.folder !== null && removeDirIfEmpty(plan.folder);
  return { step, status: 'done', detail: isFolderGone ? `removed ${shown} and its folder` : `removed ${shown}`, backup: null };
}
