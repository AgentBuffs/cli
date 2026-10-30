/**
 * Which screen a run gets. Full screen (one screen per step, in the
 * terminal's alternate screen) only where a person answers in a terminal that
 * can draw it. Everything else keeps the linear output: a pipe or CI gets
 * plain lines, a terminal with --yes, --no-fullscreen, no colour, TERM=dumb
 * or too few rows gets clack's look line by line. Pure.
 */
import { UsageError, readOptions } from './main.ts';
import type { TerminalSize } from './virtual-terminal.ts';
import { MIN_SIZE } from './wizard-view.ts';

export type ScreenMode = 'fullscreen' | 'terminal' | 'plain';

export type ScreenFacts = {
  argv: readonly string[];
  isStdinTty: boolean;
  isStdoutTty: boolean;
  /** Node's `getColorDepth()`: 1 under NO_COLOR or TERM=dumb. */
  colorBits: number;
  /** Null when the terminal does not report one. */
  size: TerminalSize | null;
  env: Readonly<Record<string, string | undefined>>;
};

function isOn(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

/** True when the flags ask for a run without questions, or for no full screen, or for no screen at all. */
function flagsWantLinear(argv: readonly string[]): boolean {
  try {
    const options = readOptions(argv);
    return options.yes || options.noFullscreen || options.help || options.version;
  } catch (error) {
    // `main` reports the usage problem, on a linear screen.
    if (error instanceof UsageError) return true;
    throw error;
  }
}

export function chooseScreenMode(facts: ScreenFacts): ScreenMode {
  if (!facts.isStdoutTty) return 'plain';
  if (!facts.isStdinTty || flagsWantLinear(facts.argv)) return 'terminal';
  if (facts.colorBits <= 1 || isOn(facts.env.NO_COLOR) || facts.env.TERM === 'dumb') return 'terminal';
  if (facts.size === null || facts.size.columns < MIN_SIZE.columns || facts.size.rows < MIN_SIZE.rows) return 'terminal';
  return 'fullscreen';
}
