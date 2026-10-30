/**
 * The questions, behind an interface so tests can answer them. The real one
 * uses @clack/prompts. A cancel (Ctrl+C or Escape) throws `CancelledError`.
 */
import { confirm, isCancel, multiselect, select } from '@clack/prompts';
import type { What } from './plan.ts';

export class CancelledError extends Error {
  override name = 'CancelledError';
}

/** `hint` is null for a harness that was not found on this machine. */
export type HarnessChoice = { slug: string; label: string; hint: string | null };

/** The answer to the plan: go, show every change first, or stop. */
export type PlanAction = 'install' | 'details' | 'cancel';

export interface Prompter {
  chooseHarnesses(opts: { choices: readonly HarnessChoice[]; preselected: readonly string[] }): Promise<string[]>;
  chooseWhat(): Promise<What>;
  /** `canShowDetails` is false once the changes are on screen. */
  choosePlanAction(opts: { canShowDetails: boolean }): Promise<PlanAction>;
  confirm(message: string): Promise<boolean>;
}

/** Rows of the harness list on screen at once; the rest scroll. */
const LIST_ROWS = 8;

function isAnswer<Value>(value: Value | symbol): value is Value {
  return !isCancel(value);
}

function answered<Value>(value: Value | symbol): Value {
  if (!isAnswer(value)) throw new CancelledError('cancelled');
  return value;
}

export const clackPrompter: Prompter = {
  async chooseHarnesses({ choices, preselected }) {
    const picked = await multiselect<string>({
      message: 'Install into which agents?',
      options: choices.map((choice) => (choice.hint === null ? { value: choice.slug, label: choice.label } : { value: choice.slug, label: choice.label, hint: choice.hint })),
      initialValues: [...preselected],
      maxItems: LIST_ROWS,
      required: true,
    });
    return answered<string[]>(picked);
  },
  async chooseWhat() {
    const picked = await select<What>({
      message: 'What should they get?',
      options: [
        { value: 'both', label: 'MCP server and skill', hint: 'default' },
        { value: 'mcp', label: 'MCP server only', hint: 'search tools in the agent' },
        { value: 'skill', label: 'Skill only', hint: 'uses the web API, no server' },
      ],
      initialValue: 'both',
    });
    return answered<What>(picked);
  },
  async choosePlanAction({ canShowDetails }) {
    const options: { value: PlanAction; label: string }[] = [
      { value: 'install', label: 'Install' },
      ...(canShowDetails ? [{ value: 'details' as const, label: 'Show the changes first' }] : []),
      { value: 'cancel', label: 'Cancel' },
    ];
    const picked = await select<PlanAction>({ message: 'Go ahead?', options, initialValue: 'install' });
    return answered<PlanAction>(picked);
  },
  async confirm(message) {
    return answered<boolean>(await confirm({ message, initialValue: true }));
  },
};
