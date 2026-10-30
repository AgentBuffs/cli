/**
 * The questions, behind an interface so tests can answer them. The real one
 * uses @clack/prompts. A cancel (Ctrl+C or Escape) throws `CancelledError`.
 */
import { confirm, isCancel, multiselect, select } from '@clack/prompts';
import type { What } from './plan.ts';

export class CancelledError extends Error {
  override name = 'CancelledError';
}

export type HarnessChoice = { slug: string; label: string; hint: string };

export interface Prompter {
  chooseHarnesses(opts: { choices: readonly HarnessChoice[]; preselected: readonly string[] }): Promise<string[]>;
  chooseWhat(): Promise<What>;
  confirm(message: string): Promise<boolean>;
}

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
      message: 'Install agentbuffs into which harnesses? (space to toggle, enter to go on)',
      options: choices.map((choice) => ({ value: choice.slug, label: choice.label, hint: choice.hint })),
      initialValues: [...preselected],
      required: true,
    });
    return answered<string[]>(picked);
  },
  async chooseWhat() {
    const picked = await select<What>({
      message: 'What should be installed?',
      options: [
        { value: 'both', label: 'MCP server and skill' },
        { value: 'mcp', label: 'MCP server only' },
        { value: 'skill', label: 'Skill only' },
      ],
      initialValue: 'both',
    });
    return answered<What>(picked);
  },
  async confirm(message) {
    return answered<boolean>(await confirm({ message, initialValue: true }));
  },
};
