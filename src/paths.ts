/**
 * Path templates from the setup document: `~`, `${PROJECT}` and, on Windows
 * only, `%APPDATA%`. Every write target must resolve inside the home dir or the
 * project dir, after symlinks are followed.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Platform, PlatformPaths } from './setup-document.ts';

/** Where the CLI runs: injected so tests use a temp home and a temp project. */
export type RunContext = {
  home: string;
  project: string;
  platform: Platform;
  env: Readonly<Record<string, string | undefined>>;
};

/** `path.posix` or `path.win32`, picked by the context's platform. */
type PlatformPath = typeof path.posix;

export class PathRefusedError extends Error {
  override name = 'PathRefusedError';
}

function pathApi(platform: Platform): PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Expands one template to an absolute path. Returns null when the template
 * needs a variable this platform does not have (`%APPDATA%` off Windows), so
 * detection can skip that entry.
 */
export function expandPath(template: string, ctx: RunContext): string | null {
  const api = pathApi(ctx.platform);
  let expanded = template;
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = ctx.home + expanded.slice(1);
  }
  expanded = expanded.replaceAll('${PROJECT}', ctx.project);
  if (expanded.includes('%APPDATA%')) {
    const appData = ctx.env.APPDATA;
    if (ctx.platform !== 'win32' || !appData) return null;
    expanded = expanded.replaceAll('%APPDATA%', appData);
  }
  if (/\$\{|\$[A-Za-z_]|%[A-Za-z_]+%/.test(expanded)) {
    throw new PathRefusedError(`The path ${template} uses a variable this version does not know.`);
  }
  return api.resolve(ctx.project, expanded);
}

/** The template for this platform: `paths.<platform>` when the action has one, else `path`. */
export function templateFor(target: { path: string; paths: PlatformPaths }, platform: Platform): string {
  return target.paths[platform] ?? target.path;
}

function isStrictlyInside(opts: { child: string; parent: string; api: PlatformPath }): boolean {
  const relative = opts.api.relative(opts.parent, opts.child);
  if (relative === '') return false;
  return !relative.startsWith('..') && !opts.api.isAbsolute(relative);
}

/** The real path of `target`, or of its nearest existing ancestor joined with the rest. */
function realPathOfDeepestAncestor(target: string, api: PlatformPath): string {
  const missing: string[] = [];
  let current = target;
  for (let depth = 0; depth < 256; depth += 1) {
    if (existsSync(current)) return api.join(realpathSync(current), ...missing.toReversed());
    const parent = api.dirname(current);
    if (parent === current) break;
    missing.push(api.basename(current));
    current = parent;
  }
  throw new PathRefusedError(`Cannot resolve ${target}.`);
}

/** The roots a write may land in. The project dir does not count when it is a filesystem root. */
function allowedRoots(ctx: RunContext): string[] {
  const api = pathApi(ctx.platform);
  const roots = [ctx.home];
  if (api.dirname(ctx.project) !== ctx.project) roots.push(ctx.project);
  return roots.map((root) => realPathOfDeepestAncestor(api.resolve(root), api));
}

/**
 * Resolves a write target. Follows symlinks, so a symlinked config file is
 * edited in place (the link stays a link), and refuses any path whose real
 * location is outside the home dir and the project dir.
 */
export function resolveWriteTarget(template: string, ctx: RunContext): string {
  const expanded = expandPath(template, ctx);
  if (expanded === null) throw new PathRefusedError(`The path ${template} does not apply on ${ctx.platform}.`);
  const api = pathApi(ctx.platform);
  const real = realPathOfDeepestAncestor(expanded, api);
  const roots = allowedRoots(ctx);
  if (!roots.some((root) => isStrictlyInside({ child: real, parent: root, api }))) {
    throw new PathRefusedError(`${template} resolves to ${real}, which is outside your home folder and this project.`);
  }
  return real;
}

/** `./...` for display when the path is in the project (and the project is not home), `~/...` when under home. */
export function displayPath(absolute: string, ctx: RunContext): string {
  const api = pathApi(ctx.platform);
  const project = realPathOfDeepestAncestor(ctx.project, api);
  const isProjectHome = project === realPathOfDeepestAncestor(ctx.home, api);
  if (!isProjectHome && isStrictlyInside({ child: absolute, parent: project, api })) {
    return `.${api.sep}${api.relative(project, absolute)}`;
  }
  const homes = [ctx.home, realPathOfDeepestAncestor(ctx.home, api)];
  for (const home of homes) {
    if (isStrictlyInside({ child: absolute, parent: home, api })) return `~${api.sep}${api.relative(home, absolute)}`;
  }
  return absolute;
}
