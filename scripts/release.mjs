// Cuts a release: `pnpm release <x.y.z>`.
//
// It refuses to start unless the tree is clean, the branch is main and equal to
// origin/main, the tag is free, the version is greater than package.json's and
// CHANGELOG.md has an undated `## [<x.y.z>]` heading. Then it dates that
// heading, sets the version in package.json (the build reads it from there, for
// `--version` too), runs `pnpm check`, commits `chore(release): <x.y.z>` and
// creates the annotated tag `v<x.y.z>`. It does not push: it prints the command.
//
// `node scripts/release.mjs notes <x.y.z>` prints that version's CHANGELOG
// section; the release workflow uses it as the GitHub Release notes.
//
// No dependencies. The pure functions are exported for the tests.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const BRANCH = 'main';
const PUSH_COMMAND = `git push origin ${BRANCH} --follow-tags`;

export class ReleaseError extends Error {
  name = 'ReleaseError';
}

/** `[major, minor, patch]` for `x.y.z`. Throws for anything else, a prerelease included. */
export function parseVersion(text) {
  const match = VERSION_PATTERN.exec(text);
  if (match === null) throw new ReleaseError(`"${text}" is not a version like 1.2.3`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when version `left` is greater than version `right`. */
export function isGreater(left, right) {
  const [a, b] = [parseVersion(left), parseVersion(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

function headingPattern(version) {
  return new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\](?: - (.*))?$`, 'm');
}

/** The CHANGELOG text with `## [version] - unreleased` dated. Throws when the heading is missing or already dated. */
export function datedChangelog({ text, version, date }) {
  const match = headingPattern(version).exec(text);
  if (match === null) throw new ReleaseError(`CHANGELOG.md has no "## [${version}]" heading. Write the release notes first.`);
  const state = match[1]?.trim() ?? '';
  if (state !== 'unreleased') {
    throw new ReleaseError(`CHANGELOG.md already has "${match[0]}". Its heading must end in " - unreleased".`);
  }
  return text.replace(match[0], `## [${version}] - ${date}`);
}

/** The body of one version's CHANGELOG section, without its heading and without the link list at the end. */
export function changelogSection({ text, version }) {
  const match = headingPattern(version).exec(text);
  if (match === null) throw new ReleaseError(`CHANGELOG.md has no "## [${version}]" heading`);
  const rest = text.slice(match.index + match[0].length);
  const next = rest.search(/^## \[/m);
  const body = (next === -1 ? rest : rest.slice(0, next)).split('\n').filter((line) => !/^\[[^\]]+\]: /.test(line));
  return `${body.join('\n').trim()}\n`;
}

/** package.json text with the version set; the rest of the file stays as it was. */
export function withVersion({ text, version }) {
  const pattern = /("version"\s*:\s*")[^"]*(")/;
  if (!pattern.test(text)) throw new ReleaseError('package.json has no "version" field');
  return text.replace(pattern, `$1${version}$2`);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function assertCanRelease(version) {
  if (git(['status', '--porcelain']) !== '') throw new ReleaseError('The working tree is not clean. Commit or stash your changes first.');
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== BRANCH) throw new ReleaseError(`You are on "${branch}". Release from ${BRANCH}.`);
  git(['fetch', 'origin', BRANCH]);
  if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', `origin/${BRANCH}`])) {
    throw new ReleaseError(`${BRANCH} is not equal to origin/${BRANCH}. Pull or push first.`);
  }
  const hasTag = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/v${version}`], { stdio: 'ignore' }).status === 0;
  if (hasTag) throw new ReleaseError(`The tag v${version} already exists.`);
}

function release(version) {
  parseVersion(version);
  const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (!isGreater(version, current)) throw new ReleaseError(`${version} is not greater than the current version ${current}.`);
  assertCanRelease(version);

  const changelog = datedChangelog({ text: readFileSync('CHANGELOG.md', 'utf8'), version, date: new Date().toISOString().slice(0, 10) });
  writeFileSync('CHANGELOG.md', changelog);
  writeFileSync('package.json', withVersion({ text: readFileSync('package.json', 'utf8'), version }));

  const check = spawnSync('pnpm', ['check'], { stdio: 'inherit' });
  if (check.status !== 0) {
    git(['checkout', '--', 'package.json', 'CHANGELOG.md']);
    throw new ReleaseError('pnpm check failed. package.json and CHANGELOG.md are back as they were.');
  }

  git(['add', 'package.json', 'CHANGELOG.md']);
  git(['commit', '-m', `chore(release): ${version}`]);
  git(['tag', '-a', `v${version}`, '-m', `agentbuffs ${version}`]);
  console.log(`\nReleased ${version} locally: commit "chore(release): ${version}" and tag v${version}.`);
  console.log('Nothing is pushed. To publish, run:\n');
  console.log(`  ${PUSH_COMMAND}\n`);
  console.log('The release workflow then publishes to npm and creates the GitHub Release.');
}

function main(args) {
  const [first, second] = args;
  if (first === 'notes' && second !== undefined) {
    process.stdout.write(changelogSection({ text: readFileSync('CHANGELOG.md', 'utf8'), version: second }));
    return;
  }
  if (first === undefined || args.length !== 1) throw new ReleaseError('Usage: pnpm release <x.y.z>');
  release(first);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(`release: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() !== '') {
      console.error(`release: ${error.message}\n${error.stderr.trim()}`);
      process.exit(1);
    }
    throw error;
  }
}
