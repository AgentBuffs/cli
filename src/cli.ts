/**
 * The `agentbuffs` binary: wires the real process, file system, prompts and
 * `execFile` into `main`, on the screen `chooseScreenMode` picks.
 */
import os from 'node:os';
import type { Writable } from 'node:stream';
import packageJson from '../package.json' with { type: 'json' };
import { makePaint, toColorDepth } from './ansi.ts';
import { fullscreenScreen, type FullscreenScreen } from './fullscreen.ts';
import { main } from './main.ts';
import { clackPrompter } from './prompts.ts';
import { execWithoutShell } from './run-action.ts';
import { chooseScreenMode, type ScreenMode } from './screen-mode.ts';
import { plainScreen, terminalScreen, type Screen } from './screen.ts';
import { runGuarded } from './session.ts';
import type { Platform } from './setup-document.ts';

/** How long the finished install screen stays before the summary replaces it. */
const DONE_HOLD_MS = 700;
const SPINNER_FRAME_MS = 80;

function currentPlatform(): Platform {
  if (process.platform === 'win32' || process.platform === 'darwin') return process.platform;
  return 'linux';
}

type Wiring = { screen: Screen; fullscreen: FullscreenScreen | null; promptOutput: Writable };

function wire(mode: ScreenMode): Wiring {
  const { stdout, stderr } = process;
  switch (mode) {
    case 'plain': {
      const screen = plainScreen({ out: (text) => stdout.write(`${text}\n`), err: (text) => stderr.write(`${text}\n`) });
      return { screen, fullscreen: null, promptOutput: stdout };
    }
    case 'terminal': {
      const paint = makePaint(toColorDepth(stdout.getColorDepth()));
      return { screen: terminalScreen({ stdout, stderr, paint }), fullscreen: null, promptOutput: stdout };
    }
    case 'fullscreen': {
      const paint = makePaint(toColorDepth(stdout.getColorDepth()));
      const fullscreen = fullscreenScreen({ stdout, stderr, paint, holdMs: DONE_HOLD_MS, frameMs: SPINNER_FRAME_MS });
      return { screen: fullscreen, fullscreen, promptOutput: fullscreen.promptOutput };
    }
  }
}

const argv = process.argv.slice(2);
const mode = chooseScreenMode({
  argv,
  isStdinTty: Boolean(process.stdin.isTTY),
  isStdoutTty: Boolean(process.stdout.isTTY),
  colorBits: process.stdout.isTTY ? process.stdout.getColorDepth() : 1,
  size: process.stdout.isTTY ? { columns: process.stdout.columns, rows: process.stdout.rows } : null,
  env: process.env,
});
const { screen, fullscreen, promptOutput } = wire(mode);

const exitCode = await runGuarded({
  fullscreen,
  events: {
    on: (event, listener) => process.on(event, listener),
    off: (event, listener) => process.off(event, listener),
  },
  exit: (code) => process.exit(code),
  run: () =>
    main({
      argv,
      out: (text) => process.stdout.write(`${text}\n`),
      isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      screen,
      ctx: { home: os.homedir(), project: process.cwd(), platform: currentPlatform(), env: process.env },
      prompter: clackPrompter({ input: process.stdin, output: promptOutput }),
      exec: execWithoutShell,
      version: packageJson.version,
    }),
});
process.exitCode = exitCode;
