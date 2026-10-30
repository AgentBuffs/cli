/**
 * The questions, behind an interface so tests can answer them. The real one
 * uses @clack/prompts. A cancel (Ctrl+C or Escape) throws `CancelledError`.
 */
import { confirm, isCancel, multiselect, select } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';
import type { What } from './plan.ts';
import { PART_CHOICE } from './render.ts';

export class CancelledError extends Error {
  override name = 'CancelledError';
}

/** `hint` is null for a harness that was not found on this machine. */
export type HarnessChoice = { slug: string; label: string; hint: string | null };

/** The answer to the plan: go, show the changes (or their next page), or stop. */
export type PlanAction = 'install' | 'details' | 'cancel';

/** What the plan question offers besides install and cancel: the changes, their next page, or nothing once all are on screen. */
export type DetailsOffer = { kind: 'first' } | { kind: 'next'; page: number; pages: number } | null;

export interface Prompter {
  chooseHarnesses(opts: { choices: readonly HarnessChoice[]; preselected: readonly string[] }): Promise<string[]>;
  chooseWhat(): Promise<What>;
  choosePlanAction(opts: { details: DetailsOffer }): Promise<PlanAction>;
  confirm(message: string): Promise<boolean>;
}

/** Rows of the harness list on screen at once; the rest page inside the list. clack shows fewer when the terminal is short. */
const LIST_ROWS = 8;

function detailsLabel(offer: Exclude<DetailsOffer, null>): string {
  if (offer.kind === 'first') return 'Show the changes first';
  return `Show more changes (page ${offer.page} of ${offer.pages})`;
}

function isAnswer<Value>(value: Value | symbol): value is Value {
  return !isCancel(value);
}

function answered<Value>(value: Value | symbol): Value {
  if (!isAnswer(value)) throw new CancelledError('cancelled');
  return value;
}

/** The real questions, read from `input` and drawn by clack on `output`: the terminal, or the full-screen view's prompt area. */
export function clackPrompter(opts: { input: Readable; output: Writable }): Prompter {
  const { input, output } = opts;
  return {
    async chooseHarnesses({ choices, preselected }) {
      const picked = await multiselect<string>({
        message: 'Install into which agents?',
        options: choices.map((choice) => (choice.hint === null ? { value: choice.slug, label: choice.label } : { value: choice.slug, label: choice.label, hint: choice.hint })),
        initialValues: [...preselected],
        maxItems: LIST_ROWS,
        required: true,
        input,
        output,
      });
      return answered<string[]>(picked);
    },
    async chooseWhat() {
      const picked = await select<What>({
        message: 'What should they get?',
        options: [
          { value: 'both', label: PART_CHOICE.both, hint: 'default' },
          { value: 'mcp', label: PART_CHOICE.mcp, hint: 'search tools in the agent' },
          { value: 'skill', label: PART_CHOICE.skill, hint: 'uses the web API, no server' },
        ],
        initialValue: 'both',
        input,
        output,
      });
      return answered<What>(picked);
    },
    async choosePlanAction({ details }) {
      const options: { value: PlanAction; label: string }[] = [
        { value: 'install', label: 'Install' },
        ...(details === null ? [] : [{ value: 'details' as const, label: detailsLabel(details) }]),
        { value: 'cancel', label: 'Cancel' },
      ];
      const picked = await select<PlanAction>({ message: 'Go ahead?', options, initialValue: 'install', input, output });
      return answered<PlanAction>(picked);
    },
    async confirm(message) {
      return answered<boolean>(await confirm({ message, initialValue: true, input, output }));
    },
  };
}
