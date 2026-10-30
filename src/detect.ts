/**
 * Harness detection: a command on PATH, or a path that exists. Reads only.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandPath, expandXdgConfigPath, type RunContext } from './paths.ts';
import type { Harness } from './setup-document.ts';

function isExecutableFile(candidate: string, ctx: RunContext): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (ctx.platform === 'win32') return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first file on PATH that runs as `command`, or null. On Windows it tries each PATHEXT. */
export function findOnPath(command: string, ctx: RunContext): string | null {
  const api = ctx.platform === 'win32' ? path.win32 : path.posix;
  const pathValue = ctx.env.PATH ?? ctx.env.Path ?? '';
  const delimiter = ctx.platform === 'win32' ? ';' : ':';
  // On Windows an extensionless file next to `claude.cmd` is a shell script that cannot run there.
  const extensions = ctx.platform === 'win32' ? (ctx.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    for (const extension of extensions) {
      const candidate = api.join(dir, command + extension.toLowerCase());
      if (isExecutableFile(candidate, ctx)) return candidate;
    }
  }
  return null;
}

function pathExists(template: string, ctx: RunContext): boolean {
  const expanded = expandPath(template, ctx);
  return expanded !== null && existsSync(expanded);
}

function xdgPathExists(relative: string, ctx: RunContext): boolean {
  const expanded = expandXdgConfigPath(relative, ctx);
  return expanded !== null && existsSync(expanded);
}

/**
 * True when any detect command is on PATH or any detect path exists. While
 * `XDG_CONFIG_HOME` is set, the XDG detect paths count too: a harness that
 * follows XDG keeps its folder there, and the default folder may not exist.
 */
export function isHarnessPresent(harness: Harness, ctx: RunContext): boolean {
  try {
    if (harness.detect.commands.some((command) => findOnPath(command, ctx) !== null)) return true;
    if (harness.detect.paths.some((template) => pathExists(template, ctx))) return true;
    return harness.detect.xdgConfigPaths.some((relative) => xdgPathExists(relative, ctx));
  } catch {
    // A detect path with an unknown variable only means "not found".
    return false;
  }
}
