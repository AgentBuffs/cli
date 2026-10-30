/**
 * `run` actions: a harness's own CLI adds the server (`claude mcp add ...`).
 * The server cannot make this CLI run an arbitrary program: the command must
 * be in the allowlist below, which ships in the package, the arguments must
 * carry the document's MCP URL, and the program starts through `execFile`
 * with no shell.
 */
import { execFile, type ExecFileException } from 'node:child_process';
import type { RunAction } from './setup-document.ts';

export const RUN_ALLOWLIST: readonly string[] = ['claude', 'codex', 'gemini', 'code', 'copilot', 'pi', 'grok', 'goose'];

/** An argument may not start with any of these, nor hold a line break or NUL anywhere. */
const SHELL_METACHARACTERS = new Set([';', '&', '|', '$', '`', '<', '>', '(', ')', '{', '}', '!', '*', '?', '[', ']', '#', '~', "'", '"', '\\', ' ', '\t']);
const FORBIDDEN_ANYWHERE = /[\n\r\0]/;

export class RunRefusedError extends Error {
  override name = 'RunRefusedError';
}

/** Throws `RunRefusedError` unless the action may run. */
export function assertRunAllowed(action: RunAction, mcpUrl: string): void {
  if (!RUN_ALLOWLIST.includes(action.command)) {
    throw new RunRefusedError(`the command "${action.command}" is not one this CLI runs`);
  }
  if (!action.args.includes(mcpUrl)) throw new RunRefusedError(`the arguments do not contain ${mcpUrl}`);
  const bad = action.args.find((arg) => arg === '' || SHELL_METACHARACTERS.has(arg.charAt(0)) || FORBIDDEN_ANYWHERE.test(arg));
  if (bad !== undefined) throw new RunRefusedError(`the argument ${JSON.stringify(bad)} is not allowed`);
}

/**
 * How to ask a harness CLI whether the server is already there. Only commands
 * whose CLI has a read-only "get" are listed; the others just run the add.
 */
export const INSTALLED_CHECKS: Readonly<Record<string, (serverName: string) => string[]>> = {
  claude: (serverName) => ['mcp', 'get', serverName],
  codex: (serverName) => ['mcp', 'get', serverName],
};

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** Runs a program without a shell. Injected so tests can watch the calls. */
export type ExecFn = (opts: { file: string; args: readonly string[] }) => Promise<ExecResult>;

const EXEC_TIMEOUT_MS = 60_000;

function exitCodeOf(error: ExecFileException | null): number {
  if (error === null) return 0;
  if (typeof error.code === 'number') return error.code;
  return 1;
}

/** A spawn problem (not found, timed out) has no numeric exit code; its message is the reason. */
function spawnProblemOf(error: ExecFileException | null): string {
  if (error === null || typeof error.code === 'number') return '';
  return error.message;
}

export const execWithoutShell: ExecFn = (opts) =>
  new Promise((resolve) => {
    execFile(
      opts.file,
      [...opts.args],
      { shell: false, timeout: EXEC_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const stderrText = [stderr, spawnProblemOf(error)].filter(Boolean).join('\n');
        resolve({ exitCode: exitCodeOf(error), stdout, stderr: stderrText });
      },
    );
  });

/** The command line as text, for the plan. Arguments with spaces are quoted. */
export function commandLine(action: RunAction): string {
  return [action.command, ...action.args].map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

/** The last lines of a failed CLI's output, for the result line. */
export function failureText(result: ExecResult): string {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  const tail = output.split('\n').slice(-3).join(' ').trim();
  return tail === '' ? `exit code ${result.exitCode}` : `exit code ${result.exitCode}: ${tail}`;
}
