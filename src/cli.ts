/**
 * The `agentbuffs` binary: wires the real process, file system, prompts and
 * `execFile` into `main`.
 */
import os from 'node:os';
import packageJson from '../package.json' with { type: 'json' };
import { makePaint, toColorDepth } from './ansi.ts';
import { main } from './main.ts';
import { clackPrompter } from './prompts.ts';
import { plainScreen, terminalScreen, type Screen } from './screen.ts';
import { execWithoutShell } from './run-action.ts';
import type { Platform } from './setup-document.ts';

function currentPlatform(): Platform {
  if (process.platform === 'win32' || process.platform === 'darwin') return process.platform;
  return 'linux';
}

/** The full look when stdout is a terminal; plain lines in a pipe or CI. */
function pickScreen(): Screen {
  if (!process.stdout.isTTY) {
    return plainScreen({ out: (text) => process.stdout.write(`${text}\n`), err: (text) => process.stderr.write(`${text}\n`) });
  }
  const paint = makePaint(toColorDepth(process.stdout.getColorDepth()));
  return terminalScreen({ stdout: process.stdout, stderr: process.stderr, paint });
}

const exitCode = await main({
  argv: process.argv.slice(2),
  out: (text) => process.stdout.write(`${text}\n`),
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  screen: pickScreen(),
  ctx: { home: os.homedir(), project: process.cwd(), platform: currentPlatform(), env: process.env },
  prompter: clackPrompter,
  exec: execWithoutShell,
  version: packageJson.version,
});
process.exitCode = exitCode;
