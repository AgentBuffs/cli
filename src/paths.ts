/**
 * Path templates from the setup document: `~`, `${PROJECT}` and, on Windows
 * only, `%APPDATA%`. A file action may also name a path below the XDG config
 * folder, used while `XDG_CONFIG_HOME` is set to an absolute path. Every write
 * target must resolve inside the home dir or the project dir, after symlinks
 * are followed; an XDG folder outside both is refused, not trusted.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { FileTarget, Platform } from './setup-document.ts';

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
export function templateFor(target: Pick<FileTarget, 'path' | 'paths'>, platform: Platform): string {
  return target.paths[platform] ?? target.path;
}

/** `XDG_CONFIG_HOME` when it is set to an absolute path. The XDG spec says to ignore a relative one. */
function xdgConfigHome(ctx: RunContext): string | null {
  const value = ctx.env.XDG_CONFIG_HOME;
  if (value === undefined || value === '') return null;
  return pathApi(ctx.platform).isAbsolute(value) ? pathApi(ctx.platform).resolve(value) : null;
}

/** The folder `XDG_CONFIG_HOME` names and the file below it, or null while the variable is unset or relative. */
function xdgLocation(relative: string, ctx: RunContext): { home: string; file: string } | null {
  const home = xdgConfigHome(ctx);
  if (home === null) return null;
  const api = pathApi(ctx.platform);
  const file = api.resolve(home, ...relative.split('/'));
  if (!isStrictlyInside({ child: file, parent: home, api })) throw new PathRefusedError(`The path ${relative} leaves the XDG config folder.`);
  return { home, file };
}

/** Where a detect path below the XDG config folder is, or null while `XDG_CONFIG_HOME` is not in use. */
export function expandXdgConfigPath(relative: string, ctx: RunContext): string | null {
  return xdgLocation(relative, ctx)?.file ?? null;
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

/** The real path of `expanded`, refused with `outsideMessage(real)` when it is not inside the home dir or the project dir. */
function realPathInsideRoots(opts: { expanded: string; ctx: RunContext; outsideMessage: (real: string) => string }): string {
  const api = pathApi(opts.ctx.platform);
  const real = realPathOfDeepestAncestor(opts.expanded, api);
  const roots = allowedRoots(opts.ctx);
  if (!roots.some((root) => isStrictlyInside({ child: real, parent: root, api }))) throw new PathRefusedError(opts.outsideMessage(real));
  return real;
}

/**
 * Resolves a write target. While `XDG_CONFIG_HOME` is set to an absolute path
 * and the action names a path below it, that path wins; otherwise the
 * template for this platform. Follows symlinks, so a symlinked config file is
 * edited in place (the link stays a link), and refuses any path whose real
 * location is outside the home dir and the project dir. That includes an XDG
 * folder outside both: the user set the variable, but a setup document must
 * never be able to write outside the two folders the README promises.
 */
export function resolveWriteTarget(target: FileTarget, ctx: RunContext): string {
  const xdg = target.xdgConfigPath === null ? null : xdgLocation(target.xdgConfigPath, ctx);
  if (xdg !== null) {
    return realPathInsideRoots({
      expanded: xdg.file,
      ctx,
      outsideMessage: (real) =>
        `XDG_CONFIG_HOME is ${xdg.home}, so the file would be ${real}. That is outside your home folder and this project, and agentbuffs writes only inside them. Add the entry by hand, or point XDG_CONFIG_HOME into your home folder.`,
    });
  }
  const template = templateFor(target, ctx.platform);
  const expanded = expandPath(template, ctx);
  if (expanded === null) throw new PathRefusedError(`The path ${template} does not apply on ${ctx.platform}.`);
  return realPathInsideRoots({
    expanded,
    ctx,
    outsideMessage: (real) => `${template} resolves to ${real}, which is outside your home folder and this project.`,
  });
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
