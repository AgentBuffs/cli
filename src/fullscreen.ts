/**
 * The full-screen wizard: the run happens in the terminal's alternate screen,
 * and each step replaces the whole screen instead of adding lines under the
 * last ones, so nothing scrolls. When the run ends, for any reason, the view
 * leaves the alternate screen (the terminal shows what was there before) and
 * prints a short summary that stays in the scrollback.
 *
 * clack's prompts do not write to the terminal directly. They write to
 * `promptOutput`, a stream that feeds a `VirtualTerminal`; the view draws
 * header, answers, body and that prompt as one screen of at most `rows` lines,
 * each row addressed by position, so no newline ever reaches the bottom row.
 * Only the rows that changed are drawn again. A resize redraws everything.
 *
 * Only for an interactive terminal with colour; `screen-mode.ts` decides.
 */
import { S_BAR, S_STEP_CANCEL, S_STEP_SUBMIT, intro, log } from '@clack/prompts';
import { Writable } from 'node:stream';
import type { Paint } from './ansi.ts';
import { terminalScreen, type Screen, type Spinner, type TerminalStream } from './screen.ts';
import { VirtualTerminal, visibleWidth, type TerminalSize } from './virtual-terminal.ts';
import {
  CLACK_SPARE_ROWS,
  PROMPT_RESERVE,
  composeScreen,
  fitBlock,
  headerLines,
  pageRows,
  promptArea,
  summaryLines,
  type Answer,
  type ScreenParts,
  type StepPlace,
} from './wizard-view.ts';

const CSI = '\u001b[';
export const ENTER_ALTERNATE = `${CSI}?1049h`;
export const LEAVE_ALTERNATE = `${CSI}?1049l`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const CLEAR_SCREEN = `${CSI}2J`;
const FRAMES: readonly string[] = ['◒', '◐', '◓', '◑'];

/** What the view says when a signal stops a run during the install, when files may already be written. */
export const STOPPED_WHILE_INSTALLING = 'Stopped during the install. Some changes may be written.\nRun agentbuffs again to finish.';
export const CANCELLED_NOTHING_WRITTEN = 'Cancelled. Nothing was written.';

export type StopSignal = 'SIGINT' | 'SIGTERM';

const EXIT_FOR_SIGNAL: Readonly<Record<StopSignal, number>> = { SIGINT: 130, SIGTERM: 143 };

/** The terminal: process.stdout, or a test double with a size that emits `resize`. */
export type SizedTerminal = TerminalStream & { rows: number };

export interface FullscreenScreen extends Screen {
  /** Where clack's prompts write. */
  readonly promptOutput: Writable;
  /** A signal ends the run: leave, say what happened, and return the exit code. */
  interrupt(signal: StopSignal): number;
  /** The last guard, for `process.on('exit')`: leaves the alternate screen and shows the cursor, nothing more. */
  restore(): void;
}

/** A stream clack writes its prompts to. It has a size, as a terminal does, and hands every write to `onText` at once. */
class PromptStream extends Writable {
  columns: number;
  rows: number;
  readonly isTTY = true;
  private readonly onText: (text: string) => void;

  constructor(opts: { size: TerminalSize; onText: (text: string) => void }) {
    super({ decodeStrings: false });
    this.columns = opts.size.columns;
    this.rows = opts.size.rows;
    this.onText = opts.onText;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.onText(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    callback();
  }
}

type SpinnerState = { text: string; frame: number; progress: readonly string[] };
type StopState = { text: string; isOk: boolean; progress: readonly string[] };
type Phase = 'before' | 'on' | 'after';

export function fullscreenScreen(opts: { stdout: SizedTerminal; stderr: Writable; paint: Paint; holdMs: number; frameMs: number }): FullscreenScreen {
  const { stdout, paint } = opts;
  /** After the full-screen part: the summary lines that stay. */
  const linear = terminalScreen({ stdout, stderr: opts.stderr, paint });

  let phase: Phase = 'before';
  let version = '';
  let place: StepPlace | null = null;
  let answers: readonly Answer[] = [];
  let body: readonly string[] = [];
  let spin: SpinnerState | null = null;
  let stopped: StopState | null = null;
  let timer: NodeJS.Timeout | null = null;
  let painted: string[] = [];
  let isPaintQueued = false;

  const size = (): TerminalSize => ({ columns: stdout.columns > 0 ? stdout.columns : 80, rows: stdout.rows > 0 ? stdout.rows : 24 });
  const prompt = new VirtualTerminal({ columns: size().columns, rows: null, isStrict: false });
  const reserve = (): number => (place === null ? 0 : PROMPT_RESERVE[place.current]);

  function progressLines(lines: readonly string[]): string[] {
    return lines.map((line) => `${paint.gray(S_BAR)}  ${line}`);
  }

  function liveBody(): string[] {
    if (spin !== null) return [...body, ...progressLines(spin.progress), `${paint.purple(FRAMES[spin.frame % FRAMES.length] ?? '')}  ${spin.text}`];
    if (stopped !== null) {
      const mark = stopped.isOk ? paint.green(S_STEP_SUBMIT) : paint.red(S_STEP_CANCEL);
      return [...body, ...progressLines(stopped.progress), `${mark}  ${stopped.text}`];
    }
    return [...body];
  }

  function parts(): ScreenParts {
    const now = size();
    return { header: headerLines({ version, place, size: now, paint }), summary: summaryLines({ answers, paint, columns: now.columns }), body: liveBody() };
  }

  /** Tells clack how much room its prompt has, as a terminal of that size would. */
  function sizePromptArea(): void {
    const now = size();
    promptOutput.columns = now.columns;
    promptOutput.rows = promptArea({ parts: parts(), rows: now.rows, reserve: reserve() }).promptRows + CLACK_SPARE_ROWS;
  }

  function draw(opts: { isFull: boolean }): void {
    if (phase !== 'on') return;
    const now = size();
    const lines = composeScreen({ parts: parts(), prompt: prompt.lines(), size: now, reserve: reserve() });
    let output = opts.isFull ? `${CSI}0m${CLEAR_SCREEN}` : '';
    const next: string[] = [];
    for (let row = 0; row < now.rows; row += 1) {
      const line = lines[row] ?? '';
      next.push(line);
      if (!opts.isFull && painted[row] === line) continue;
      const clearRest = visibleWidth(line) < now.columns ? `${CSI}K` : '';
      output += `${CSI}${row + 1};1H${line}${CSI}0m${clearRest}`;
    }
    painted = next;
    if (output !== '') stdout.write(output);
  }

  /** One draw after the writes of this tick: clack draws a prompt in several writes. */
  function drawSoon(): void {
    if (isPaintQueued) return;
    isPaintQueued = true;
    queueMicrotask(() => {
      isPaintQueued = false;
      draw({ isFull: false });
    });
  }

  const promptOutput = new PromptStream({
    size: size(),
    onText: (text) => {
      // clack hides the cursor first thing when a prompt opens: a new prompt starts on an empty prompt area.
      if (text.startsWith(HIDE_CURSOR)) prompt.reset();
      prompt.write(text);
      drawSoon();
    },
  });

  function onResize(): void {
    prompt.resize({ columns: size().columns, rows: null });
    sizePromptArea();
    // clack listens for this and draws its prompt again for the new size.
    promptOutput.emit('resize');
    draw({ isFull: true });
  }

  function stopTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  /** Back to the normal screen. The summary starts with the version line and, after an install, its last line. */
  function leaveNow(): void {
    if (phase !== 'on') return;
    stopTimer();
    stdout.off('resize', onResize);
    stdout.write(`${CSI}0m${LEAVE_ALTERNATE}${SHOW_CURSOR}`);
    phase = 'after';
    intro(paint.badge(` agentbuffs ${version} `), { output: stdout });
    if (stopped === null) return;
    const mark = stopped.isOk ? paint.green(S_STEP_SUBMIT) : paint.red(S_STEP_CANCEL);
    log.message(stopped.text, { output: stdout, symbol: mark });
  }

  /** A body block, cut to the room left above the prompt. */
  function showBlock(opts: { title: string; lines: readonly string[] }): void {
    const now = size();
    const header = headerLines({ version, place, size: now, paint }).length;
    body = fitBlock({ title: opts.title, lines: opts.lines, rows: now.rows - header - reserve(), paint });
    prompt.reset();
    sizePromptArea();
    draw({ isFull: false });
  }

  function spinner(text: string): Spinner {
    stopTimer();
    spin = { text, frame: 0, progress: [] };
    stopped = null;
    sizePromptArea();
    draw({ isFull: false });
    timer = setInterval(() => {
      if (spin === null) return;
      spin = { ...spin, frame: spin.frame + 1 };
      draw({ isFull: false });
    }, opts.frameMs);
    timer.unref();
    return {
      message: (next) => {
        if (spin === null) return;
        spin = { ...spin, text: next };
        draw({ isFull: false });
      },
      progress: (lines) => {
        if (spin === null) return;
        spin = { ...spin, progress: [...lines] };
        draw({ isFull: false });
      },
      stop: ({ text: last, isOk }) => {
        stopTimer();
        stopped = { text: last, isOk, progress: spin?.progress ?? [] };
        spin = null;
        draw({ isFull: false });
      },
      clear: () => {
        stopTimer();
        spin = null;
        sizePromptArea();
        draw({ isFull: false });
      },
    };
  }

  return {
    paint,
    get width() {
      return Math.max(20, size().columns - 3);
    },
    promptOutput,
    start: (next) => {
      version = next;
      phase = 'on';
      stdout.write(`${ENTER_ALTERNATE}${HIDE_CURSOR}${CSI}H`);
      stdout.on('resize', onResize);
      draw({ isFull: true });
    },
    step: ({ place: nextPlace, answers: nextAnswers }) => {
      if (phase !== 'on') return;
      place = nextPlace;
      answers = [...nextAnswers];
      body = [];
      spin = null;
      stopped = null;
      stopTimer();
      prompt.reset();
      sizePromptArea();
      draw({ isFull: false });
    },
    pageRows: () => pageRows(size()),
    leave: async () => {
      if (phase !== 'on') return;
      if (stopped !== null && opts.holdMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.holdMs));
      leaveNow();
    },
    spinner: (text) => (phase === 'on' ? spinner(text) : linear.spinner(text)),
    note: (block) => (phase === 'on' ? showBlock(block) : linear.note(block)),
    section: (block) => (phase === 'on' ? showBlock(block) : linear.section(block)),
    list: (lines) => {
      leaveNow();
      linear.list(lines);
    },
    aside: (text) => {
      leaveNow();
      linear.aside(text);
    },
    end: (closing) => {
      leaveNow();
      linear.end(closing);
    },
    fail: (message) => {
      leaveNow();
      linear.fail(message);
    },
    interrupt: (signal) => {
      const wasOn = phase === 'on';
      const isInstalling = place?.current === 'install';
      leaveNow();
      if (wasOn) linear.fail(isInstalling ? STOPPED_WHILE_INSTALLING : CANCELLED_NOTHING_WRITTEN);
      return EXIT_FOR_SIGNAL[signal];
    },
    restore: () => {
      if (phase !== 'on') return;
      stopTimer();
      stdout.write(`${CSI}0m${LEAVE_ALTERNATE}${SHOW_CURSOR}`);
      phase = 'after';
    },
  };
}
