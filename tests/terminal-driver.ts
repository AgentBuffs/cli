/**
 * Runs `main` on the full-screen view with clack's real prompts, as a person
 * at a terminal would: a fake terminal of a fixed size takes every byte, a
 * fake keyboard sends keys when the screen asks, and a `VirtualTerminal`
 * shows what the person sees and counts any scroll or wrap.
 */
import { PassThrough } from 'node:stream';
import { makePaint } from '../src/ansi.ts';
import { fullscreenScreen, type FullscreenScreen } from '../src/fullscreen.ts';
import { main, type CliIo } from '../src/main.ts';
import { clackPrompter } from '../src/prompts.ts';
import { execWithoutShell, type ExecFn } from '../src/run-action.ts';
import { VirtualTerminal, type TerminalSize } from '../src/virtual-terminal.ts';
import type { TempEnv } from './helpers.ts';

export const KEY = { enter: '\r', down: '\u001b[B', up: '\u001b[A', ctrlC: '\u0003' } as const;

export type FakeTerminal = PassThrough & { columns: number; rows: number; isTTY: true };

/** A terminal of `size` that hands every write to `onText`. */
export function fakeTerminal(size: TerminalSize, onText: (text: string) => void): FakeTerminal {
  const stream = Object.assign(new PassThrough(), { columns: size.columns, rows: size.rows, isTTY: true as const });
  stream.on('data', (chunk: Buffer) => onText(chunk.toString('utf8')));
  return stream;
}

/** A keyboard: clack puts it in raw mode, which a pipe does not have. */
export function fakeKeyboard(): PassThrough & { isTTY: true; setRawMode: (isRaw: boolean) => void } {
  return Object.assign(new PassThrough(), { isTTY: true as const, setRawMode: () => undefined });
}

/** What to press for a screen, or null to wait. Called each time the screen changes. */
export type React = (screen: string) => string | null;

export type Session = {
  term: VirtualTerminal;
  stdout: FakeTerminal;
  screen: FullscreenScreen;
  /** Every distinct screen seen in the alternate screen, as plain text. */
  screens: string[];
  /** Every byte written, stdout and stderr in order. */
  bytes: () => string;
};

/** The pieces of a full-screen run, wired; `start` must be called to run `main`. */
export function fullscreenSession(opts: { size: TerminalSize; react: React }): Session & { keyboard: ReturnType<typeof fakeKeyboard> } {
  const term = new VirtualTerminal({ columns: opts.size.columns, rows: opts.size.rows, isStrict: true });
  const keyboard = fakeKeyboard();
  const chunks: string[] = [];
  const screens: string[] = [];
  let reactedTo = '';
  const onText = (text: string): void => {
    chunks.push(text);
    term.write(text);
    if (!term.isAlternate) return;
    const now = term.text().join('\n');
    if (screens.at(-1) !== now) screens.push(now);
    if (now === reactedTo) return;
    const keys = opts.react(now);
    if (keys === null) return;
    reactedTo = now;
    // After clack has finished this render.
    setImmediate(() => keyboard.write(keys));
  };
  const stdout = fakeTerminal(opts.size, onText);
  const stderr = new PassThrough();
  stderr.on('data', (chunk: Buffer) => onText(chunk.toString('utf8')));
  const screen = fullscreenScreen({ stdout, stderr, paint: makePaint(24), holdMs: 0, frameMs: 60_000 });
  return { term, stdout, screen, screens, keyboard, bytes: () => chunks.join('') };
}

/** Runs `main` on a full-screen session. */
export async function runFullscreen(opts: {
  env: TempEnv;
  argv: string[];
  size: TerminalSize;
  react: React;
  exec?: ExecFn;
}): Promise<Session & { code: number }> {
  const session = fullscreenSession({ size: opts.size, react: opts.react });
  const io: CliIo = {
    argv: opts.argv,
    out: () => undefined,
    screen: session.screen,
    isInteractive: true,
    ctx: opts.env.ctx,
    prompter: clackPrompter({ input: session.keyboard, output: session.screen.promptOutput }),
    exec: opts.exec ?? execWithoutShell,
    version: '9.9.9',
  };
  const code = await main(io);
  // Let the last writes reach the fake terminal.
  await new Promise((resolve) => setImmediate(resolve));
  return { ...session, code };
}

/** How often each alternate-screen and cursor switch happened. */
export function countModes(term: VirtualTerminal): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const mode of term.modes) counts[mode] = (counts[mode] ?? 0) + 1;
  return counts;
}
