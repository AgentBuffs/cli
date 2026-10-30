/**
 * Where the CLI's words go. `plainScreen` writes plain lines (a pipe, CI, the
 * tests). `terminalScreen` draws the banner, clack's guide line, a spinner and
 * colour, one line after another. `fullscreenScreen` (fullscreen.ts) draws
 * one whole screen per step instead. `main` talks only to the `Screen`, so
 * all three show the same words.
 */
import { S_BAR, S_STEP_CANCEL, S_STEP_SUBMIT, cancel, intro, log, note, outro, unicodeOr } from '@clack/prompts';
import type { Writable } from 'node:stream';
import { PLAIN, type Paint } from './ansi.ts';
import { BANNER_WIDTH, bannerLines } from './banner.ts';
import { wrapText, type Closing } from './render.ts';
import type { Answer, StepPlace } from './wizard-view.ts';

export type Spinner = {
  /** Shows what is running now. */
  message(text: string): void;
  /** Ends with a line that stays, marked as done or as a problem. */
  stop(opts: { text: string; isOk: boolean }): void;
  /** Ends and removes the spinner without a trace. */
  clear(): void;
  /** The results so far, shown above the spinner. Only the full-screen view shows them; the others print the results at the end. */
  progress(lines: readonly string[]): void;
};

export interface Screen {
  paint: Paint;
  /** Columns for the text inside a note; plain output does not wrap. */
  width: number;
  /** The opening: a banner and the version in a terminal, one line in a pipe. */
  start(version: string): void;
  /** A new step of the wizard, with the answers so far. Only the full-screen view draws it. */
  step(opts: { place: StepPlace; answers: readonly Answer[] }): void;
  /** Rows one page of changes may take. Infinite when the output scrolls. */
  pageRows(): number;
  /**
   * Ends the full-screen part: back to the normal screen, where what follows
   * stays in the scrollback. Does nothing for a linear screen, and nothing
   * the second time. `end` and `fail` leave by themselves.
   */
  leave(): Promise<void>;
  spinner(text: string): Spinner;
  /** A short titled block in a box: the plan. */
  note(opts: { title: string; lines: readonly string[] }): void;
  /** A titled block without a box, for long lines that must stay whole: the changes, the manual steps. */
  section(opts: { title: string; lines: readonly string[] }): void;
  /** Lines under the last spinner or note: the results. */
  list(lines: readonly string[]): void;
  /** One quiet line: the backups. */
  aside(text: string): void;
  /** The last words. */
  end(closing: Closing): void;
  /** Ends the run with a problem or a cancel, on stderr. */
  fail(message: string): void;
}

type Write = (text: string) => void;

/** Plain lines through `out` and `err`, one call per line group. */
export function plainScreen(opts: { out: Write; err: Write }): Screen {
  const { out, err } = opts;
  const indented = (lines: readonly string[]): string[] => lines.map((line) => (line === '' ? '' : `  ${line}`));
  return {
    paint: PLAIN,
    width: Number.POSITIVE_INFINITY,
    start: (version) => out(`agentbuffs ${version}`),
    step: () => undefined,
    pageRows: () => Number.POSITIVE_INFINITY,
    leave: () => Promise.resolve(),
    spinner: () => ({
      message: () => undefined,
      stop: ({ text }) => out(`\n${text}`),
      clear: () => undefined,
      progress: () => undefined,
    }),
    note: ({ title, lines }) => out(['', title, ...indented(lines)].join('\n')),
    section: ({ title, lines }) => out(['', title, ...indented(lines)].join('\n')),
    list: (lines) => out(indented(lines).join('\n')),
    aside: (text) => out(`\n${text}`),
    end: ({ lines, aside }) => out(['', ...lines, ...(aside === null ? [] : [aside])].join('\n')),
    fail: (message) => err(message),
  };
}

const FRAMES: readonly string[] = unicodeOr('◒ ◐ ◓ ◑', '• o O 0').split(' ');
const FRAME_MS = 80;
const ERASE_LINE = '\r\u001b[2K';
const UP = '\u001b[1A';

/**
 * A spinner in clack's look. Not clack's own: that one takes over stdin and
 * turns Ctrl+C into exit code 0, even while a harness CLI runs. This one
 * leaves Ctrl+C to the terminal.
 */
function terminalSpinner(opts: { write: Write; paint: Paint; columns: number; text: string }): Spinner {
  const { write, paint } = opts;
  let text = opts.text;
  let frame = 0;
  const fit = (line: string): string => (line.length > opts.columns - 4 ? `${line.slice(0, opts.columns - 5)}…` : line);
  const draw = (): void => {
    write(`${ERASE_LINE}${paint.purple(FRAMES[frame % FRAMES.length] ?? '')}  ${fit(text)}`);
    frame += 1;
  };
  write(`${paint.gray(S_BAR)}\n`);
  draw();
  const timer = setInterval(draw, FRAME_MS);
  timer.unref();
  return {
    message: (next) => {
      text = next;
      draw();
    },
    stop: ({ text: last, isOk }) => {
      clearInterval(timer);
      const mark = isOk ? paint.green(S_STEP_SUBMIT) : paint.red(S_STEP_CANCEL);
      write(`${ERASE_LINE}${mark}  ${last}\n`);
    },
    clear: () => {
      clearInterval(timer);
      write(`${ERASE_LINE}${UP}${ERASE_LINE}`);
    },
    progress: () => undefined,
  };
}

/** A terminal stream: process.stdout, or a test double with a width. */
export type TerminalStream = Writable & { columns: number };

/** The full look, for a terminal: banner, clack's guide line, spinner, colour. No banner when it does not fit. */
export function terminalScreen(opts: { stdout: TerminalStream; stderr: Writable; paint: Paint }): Screen {
  const { paint, stdout, stderr } = opts;
  const output = stdout;
  const write: Write = (text) => {
    stdout.write(text);
  };
  const columns = stdout.columns;
  // The text after clack's "│  " prefix.
  const textWidth = Math.max(20, columns - 3);
  const wrap = (text: string): string[] => wrapText({ text, width: textWidth, indent: 0 });
  return {
    paint,
    width: textWidth,
    start: (version) => {
      if (columns >= BANNER_WIDTH) write(`\n${bannerLines({ depth: paint.depth }).join('\n')}\n\n`);
      intro(paint.badge(` agentbuffs ${version} `), { output });
    },
    step: () => undefined,
    pageRows: () => Number.POSITIVE_INFINITY,
    leave: () => Promise.resolve(),
    spinner: (text) => terminalSpinner({ write, paint, columns, text }),
    note: ({ title, lines }) => note(lines.join('\n'), title, { output, format: (line) => line }),
    section: ({ title, lines }) => {
      log.step(title, { output });
      log.message([...lines], { output, spacing: 0 });
    },
    list: (lines) => log.message([...lines], { output, spacing: 0 }),
    aside: (text) => log.message(wrap(text).map(paint.dim), { output }),
    end: ({ lines, aside }) => {
      const [first = '', ...rest] = lines;
      const body = [...wrap(first), ...rest.map(paint.purple), ...(aside === null ? [] : wrap(aside).map(paint.dim))];
      outro(body.join('\n   '), { output });
    },
    fail: (message) => cancel(message.split('\n').join('\n   '), { output: stderr }),
  };
}
