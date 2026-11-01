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

const SCOPES: readonly string[] = ['local', 'user', 'project'];

/** The scope an add command names (`--scope user`, `-s user`), or null when it names none. Throws for a scope this CLI does not know. */
function scopeOf(args: readonly string[]): string | null {
  const index = args.findIndex((arg) => arg === '--scope' || arg === '-s' || arg.startsWith('--scope='));
  if (index === -1) return null;
  const arg = args[index] ?? '';
  const value = arg.startsWith('--scope=') ? arg.slice('--scope='.length) : args[index + 1];
  if (value === undefined || !SCOPES.includes(value)) throw new RunRefusedError(`the scope ${JSON.stringify(value)} is not one this CLI knows`);
  return value;
}

type RemoveContext = { serverName: string; scope: string | null };

/**
 * The remove command of each harness CLI that has one, written here and never
 * taken from the server. The server's add command only picks the scope, from
 * the three values in `SCOPES`. A CLI that is not in this table gets manual
 * steps instead.
 */
const REMOVE_COMMANDS: Readonly<Record<string, (context: RemoveContext) => string[]>> = {
  claude: ({ serverName, scope }) => ['mcp', 'remove', serverName, ...(scope === null ? [] : ['--scope', scope])],
  codex: ({ serverName }) => ['mcp', 'remove', serverName],
  gemini: ({ serverName, scope }) => ['mcp', 'remove', ...(scope === null ? [] : ['--scope', scope]), serverName],
  pi: ({ serverName }) => ['mcp', 'remove', serverName],
};

/**
 * The arguments that undo `add`, or null when this CLI has no known remove
 * command. Throws `RunRefusedError` when the add command names a scope this CLI
 * does not know.
 */
export function removeArgsFor(add: RunAction, serverName: string): string[] | null {
  const build = REMOVE_COMMANDS[add.command];
  if (build === undefined) return null;
  return build({ serverName, scope: scopeOf(add.args) });
}

/** True when `url` is one of the words of `output`, so `/mcp` does not count for `/mcp?reports=off`. */
export function mentionsUrl(output: string, url: string): boolean {
  return output.split(/[\s"',]+/).includes(url);
}

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
