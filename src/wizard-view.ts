/**
 * The full-screen wizard's layout, top to bottom: a header (the banner with
 * the version and the step beside the flame's base, or one compact line on a
 * small terminal), the answers so far (one dim line each), a body (a spinner,
 * the plan, a page of changes, the install progress) and the open prompt.
 *
 * Every function returns lines and decides nothing about streams, so the
 * tests can render each screen at 80 by 24 and measure it. Pure.
 */
import { S_BAR, S_STEP_SUBMIT } from '@clack/prompts';
import type { Paint } from './ansi.ts';
import { BANNER_WIDTH, BESIDE_WIDTH, bannerLines } from './banner.ts';
import { cropToWidth, visibleWidth, type TerminalSize } from './virtual-terminal.ts';

/** The steps in their order. A run shows only the ones it asks. */
export type WizardStep = 'agents' | 'parts' | 'plan' | 'install';

export const STEP_NAME: Readonly<Record<WizardStep, string>> = { agents: 'Agents', parts: 'Parts', plan: 'Plan', install: 'Install' };

/** Where the run is: the steps it shows, and the one on screen. */
export type StepPlace = { steps: readonly WizardStep[]; current: WizardStep };

/** One answer so far: `Agents  Claude Code, Codex`. */
export type Answer = { label: string; value: string };

/** The smallest terminal the full-screen view runs in. Below it, the output is linear. */
export const MIN_SIZE: TerminalSize = { columns: 60, rows: 18 };

/** The full banner needs this many rows: 24 fits every screen with it. */
export const FULL_BANNER_ROWS = 24;

/**
 * Rows to keep free for the prompt of each step, so the summary gives way
 * before the prompt does. A clack prompt opens with a guide bar and its
 * message, and ends with a help line and an end mark: the agent list shows at
 * least five rows of options (9 in all), a select with three options takes 7.
 */
export const PROMPT_RESERVE: Readonly<Record<WizardStep, number>> = { agents: 9, parts: 7, plan: 7, install: 0 };

/**
 * clack sizes a list for a terminal two rows taller than the frame it draws
 * (it keeps room for the line after it). The prompt area tells clack it has
 * this many rows more than it really has, so the frame fills the area exactly.
 */
export const CLACK_SPARE_ROWS = 2;

export function hasFullBanner(size: TerminalSize): boolean {
  return size.columns >= BANNER_WIDTH && size.rows >= FULL_BANNER_ROWS;
}

/** `Step 2 of 4 · Parts`, or '' before the steps are known. */
export function stepText(place: StepPlace | null): string {
  if (place === null) return '';
  const index = place.steps.indexOf(place.current);
  if (index === -1) throw new Error(`The step ${place.current} is not in ${place.steps.join(', ')}`);
  return `Step ${index + 1} of ${place.steps.length} · ${STEP_NAME[place.current]}`;
}

/** The header: the banner, or one line on a small terminal, then a blank line. */
export function headerLines(opts: { version: string; place: StepPlace | null; size: TerminalSize; paint: Paint }): string[] {
  const { paint } = opts;
  const step = stepText(opts.place);
  const badge = paint.badge(` agentbuffs ${opts.version} `);
  const beside = step === '' ? badge : `${badge}  ${paint.purple(step)}`;
  if (hasFullBanner(opts.size) && visibleWidth(beside) <= BESIDE_WIDTH) return [...bannerLines({ depth: paint.depth, beside }), ''];
  const word = `${paint.bold('agent')}${paint.bold(paint.purple('buffs'))}`;
  const compact = step === '' ? `${word} ${paint.dim(opts.version)}` : `${word} ${paint.dim(opts.version)}   ${paint.purple(step)}`;
  return [cropToWidth(compact, opts.size.columns), ''];
}

/** The answers so far, one dim line each, then the guide bar. Empty with no answers. */
export function summaryLines(opts: { answers: readonly Answer[]; paint: Paint; columns: number }): string[] {
  const { answers, paint } = opts;
  if (answers.length === 0) return [];
  const labelWidth = Math.max(...answers.map((answer) => answer.label.length));
  const lines = answers.map((answer) => {
    const head = `${S_STEP_SUBMIT}  ${answer.label.padEnd(labelWidth)}  `;
    const room = opts.columns - head.length;
    const value = answer.value.length > room ? `${answer.value.slice(0, Math.max(0, room - 1))}…` : answer.value;
    return `${paint.green(S_STEP_SUBMIT)}  ${answer.label.padEnd(labelWidth)}  ${paint.dim(value)}`;
  });
  return [...lines, paint.gray(S_BAR)];
}

/** A titled block in clack's look: `◇  Plan`, then the lines behind the guide bar. The prompt under it brings its own bar. */
export function blockLines(opts: { title: string; lines: readonly string[]; paint: Paint }): string[] {
  const { paint } = opts;
  return [`${paint.green(S_STEP_SUBMIT)}  ${opts.title}`, ...opts.lines.map((line) => `${paint.gray(S_BAR)}  ${line}`)];
}

/**
 * The block cut to `rows` rows. A cut block ends with a line that says how
 * many lines are left out, so nothing goes missing without a word.
 */
export function fitBlock(opts: { title: string; lines: readonly string[]; rows: number; paint: Paint }): string[] {
  const { lines, rows, paint } = opts;
  if (lines.length + 1 <= rows) return blockLines(opts);
  const kept = Math.max(0, rows - 2);
  const hidden = lines.length - kept;
  return blockLines({ title: opts.title, lines: [...lines.slice(0, kept), paint.dim(`and ${hidden} more, Show the changes lists them all`)], paint });
}

export type ScreenParts = { header: readonly string[]; summary: readonly string[]; body: readonly string[] };

/** Whether the summary fits beside the body and the prompt's reserve, and how many rows the prompt gets. */
export function promptArea(opts: { parts: ScreenParts; rows: number; reserve: number }): { hasSummary: boolean; promptRows: number } {
  const { header, summary, body } = opts.parts;
  const withSummary = opts.rows - header.length - summary.length - body.length;
  if (withSummary >= opts.reserve) return { hasSummary: true, promptRows: withSummary };
  return { hasSummary: false, promptRows: Math.max(0, opts.rows - header.length - body.length) };
}

function isBareBar(line: string | undefined): boolean {
  return line !== undefined && line.replaceAll(/\u001b\[[0-9;]*m/g, '').trim() === S_BAR;
}

/** Drops a guide bar that follows another one, and one right under the header, where the blank line already separates. */
function tidyBars(lines: readonly string[]): string[] {
  return lines.filter((line, index) => !(isBareBar(line) && (index === 0 || isBareBar(lines[index - 1]))));
}

/**
 * One whole screen: header, summary (when it fits), body, prompt. Never more
 * than `size.rows` lines and never wider than `size.columns`: the bottom and
 * the right are cut, so the terminal never scrolls or wraps. The tests check
 * that nothing real is ever cut.
 */
export function composeScreen(opts: { parts: ScreenParts; prompt: readonly string[]; size: TerminalSize; reserve: number }): string[] {
  const { parts, size } = opts;
  const { hasSummary } = promptArea({ parts, rows: size.rows, reserve: opts.reserve });
  const lines = [...parts.header, ...tidyBars([...(hasSummary ? parts.summary : []), ...parts.body, ...opts.prompt])];
  return lines.slice(0, size.rows).map((line) => cropToWidth(line, size.columns));
}

/** Rows a page of changes may take on the plan screen, under the header, beside the plan question. */
export function pageRows(size: TerminalSize): number {
  const header = hasFullBanner(size) ? 9 : 2;
  // The block's title takes one row.
  return Math.max(3, size.rows - header - PROMPT_RESERVE.plan - 1);
}

/** Splits lines into pages of `rows`. One page, the whole list, when `rows` is infinite. */
export function toPages(lines: readonly string[], rows: number): string[][] {
  if (!Number.isFinite(rows) || lines.length <= rows) return [[...lines]];
  const pages: string[][] = [];
  for (let start = 0; start < lines.length; start += rows) pages.push(lines.slice(start, start + rows));
  return pages;
}
