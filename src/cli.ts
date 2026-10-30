/**
 * The `agentbuffs` binary: wires the real process, file system, prompts and
 * `execFile` into `main`.
 */
import os from 'node:os';
import packageJson from '../package.json' with { type: 'json' };
import { main } from './main.ts';
import { clackPrompter } from './prompts.ts';
import { execWithoutShell } from './run-action.ts';
import type { Platform } from './setup-document.ts';

function currentPlatform(): Platform {
  if (process.platform === 'win32' || process.platform === 'darwin') return process.platform;
  return 'linux';
}

const exitCode = await main({
  argv: process.argv.slice(2),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ctx: { home: os.homedir(), project: process.cwd(), platform: currentPlatform(), env: process.env },
  prompter: clackPrompter,
  exec: execWithoutShell,
  version: packageJson.version,
});
process.exitCode = exitCode;
