import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogSection, datedChangelog, isGreater, parseVersion, ReleaseError, withVersion } from '../scripts/release.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release.mjs');

const CHANGELOG = `# Changelog

## [0.4.0] - unreleased

### Added

- Four.

## [0.3.2] - 2026-10-31

### Fixed

- Three.

[0.4.0]: https://example.invalid/compare/v0.3.2...v0.4.0
[0.3.2]: https://example.invalid/releases/tag/v0.3.2
`;

describe('parseVersion and isGreater', () => {
  it('reads x.y.z and nothing else', () => {
    assert.deepEqual(parseVersion('10.2.3'), [10, 2, 3]);
    for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta.1', '1.2.3.4', '', 'latest']) assert.throws(() => parseVersion(bad), ReleaseError, bad);
  });

  it('compares numbers, not text', () => {
    assert.equal(isGreater('0.10.0', '0.9.9'), true);
    assert.equal(isGreater('1.0.0', '0.99.99'), true);
    assert.equal(isGreater('0.3.3', '0.3.2'), true);
    assert.equal(isGreater('0.3.2', '0.3.2'), false);
    assert.equal(isGreater('0.3.1', '0.3.2'), false);
  });
});

describe('datedChangelog', () => {
  it('puts the date on an unreleased heading and changes nothing else', () => {
    const text = datedChangelog({ text: CHANGELOG, version: '0.4.0', date: '2026-11-02' });
    assert.equal(text, CHANGELOG.replace('## [0.4.0] - unreleased', '## [0.4.0] - 2026-11-02'));
  });

  it('refuses a missing heading and a heading that already has a date', () => {
    assert.throws(() => datedChangelog({ text: CHANGELOG, version: '0.5.0', date: '2026-11-02' }), /no "## \[0\.5\.0\]" heading/);
    assert.throws(() => datedChangelog({ text: CHANGELOG, version: '0.3.2', date: '2026-11-02' }), /already has "## \[0\.3\.2\] - 2026-10-31"/);
  });

  it('does not take 0.4.0 for 0.40.0 or 10.4.0', () => {
    assert.throws(() => datedChangelog({ text: '## [0.40.0] - unreleased\n', version: '0.4.0', date: 'd' }), ReleaseError);
  });
});

describe('changelogSection', () => {
  it('returns one section without its heading and without the link list', () => {
    assert.equal(changelogSection({ text: CHANGELOG, version: '0.4.0' }), '### Added\n\n- Four.\n');
    assert.equal(changelogSection({ text: CHANGELOG, version: '0.3.2' }), '### Fixed\n\n- Three.\n');
  });

  it('throws for a version that has no section', () => {
    assert.throws(() => changelogSection({ text: CHANGELOG, version: '9.9.9' }), ReleaseError);
  });
});

describe('withVersion', () => {
  it('changes only the version field', () => {
    const text = '{\n  "name": "x",\n  "version": "0.3.2",\n  "dependencies": { "version": "1" }\n}\n';
    assert.equal(withVersion({ text, version: '0.4.0' }), '{\n  "name": "x",\n  "version": "0.4.0",\n  "dependencies": { "version": "1" }\n}\n');
  });
});

describe('scripts/release.mjs in a throwaway repository', () => {
  let root: string;
  let repo: string;
  let fakeBin: string;

  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const run = (...args: string[]): { code: number; out: string; err: string } => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return { code: result.status ?? -1, out: result.stdout, err: result.stderr };
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'agentbuffs-release-'));
    repo = path.join(root, 'repo');
    fakeBin = path.join(root, 'bin');
    mkdirSync(fakeBin);
    mkdirSync(repo);
    // A pnpm that records its call and passes, or fails when `pnpm-fails` exists.
    writeFileSync(path.join(fakeBin, 'pnpm'), `#!/bin/sh\necho "$@" >> "${root}/pnpm.log"\n[ -f "${root}/pnpm-fails" ] && exit 1\nexit 0\n`);
    chmodSync(path.join(fakeBin, 'pnpm'), 0o755);
    execFileSync('git', ['init', '--bare', '-b', 'main', path.join(root, 'origin.git')], { stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'release@example.invalid');
    git('config', 'user.name', 'Release Test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    git('remote', 'add', 'origin', path.join(root, 'origin.git'));
    writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "x",\n  "version": "0.3.2"\n}\n');
    writeFileSync(path.join(repo, 'CHANGELOG.md'), CHANGELOG);
    git('add', '.');
    git('commit', '-m', 'init');
    git('push', '-u', 'origin', 'main');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const head = (): string => git('rev-parse', 'HEAD');

  it('dates the heading, sets the version, runs pnpm check, commits, tags, and prints the push command without pushing', () => {
    const result = run('0.4.0');
    assert.equal(result.code, 0, result.err);
    assert.match(readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), /^## \[0\.4\.0\] - \d{4}-\d{2}-\d{2}$/m);
    assert.equal(JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '0.4.0');
    assert.equal(readFileSync(path.join(root, 'pnpm.log'), 'utf8').trim(), 'check');
    assert.equal(git('log', '-1', '--format=%s'), 'chore(release): 0.4.0');
    assert.equal(git('cat-file', '-t', 'v0.4.0'), 'tag', 'an annotated tag');
    assert.equal(git('rev-parse', 'v0.4.0^{commit}'), head());
    assert.equal(git('status', '--porcelain'), '');
    assert.match(result.out, /git push origin main --follow-tags/);
    assert.notEqual(git('rev-parse', 'origin/main'), head(), 'nothing was pushed');
    assert.equal(spawnSync('git', ['ls-remote', '--tags', 'origin'], { cwd: repo, encoding: 'utf8' }).stdout, '');
  });

  it('restores both files and makes no commit when pnpm check fails', () => {
    writeFileSync(path.join(root, 'pnpm-fails'), '');
    const before = head();
    const result = run('0.4.0');
    assert.equal(result.code, 1);
    assert.match(result.err, /pnpm check failed/);
    assert.equal(head(), before);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('tag', '--list'), '');
  });

  const refusals: Array<{ name: string; arrange: () => void; args: string[]; message: RegExp }> = [
    { name: 'a dirty tree', arrange: () => writeFileSync(path.join(repo, 'stray.txt'), 'x'), args: ['0.4.0'], message: /not clean/ },
    { name: 'a branch other than main', arrange: () => git('checkout', '-b', 'topic'), args: ['0.4.0'], message: /You are on "topic"/ },
    {
      name: 'a main that differs from origin/main',
      arrange: () => {
        writeFileSync(path.join(repo, 'more.txt'), 'x');
        git('add', '.');
        git('commit', '-m', 'local only');
      },
      args: ['0.4.0'],
      message: /not equal to origin\/main/,
    },
    { name: 'a version that is not greater', arrange: () => undefined, args: ['0.3.2'], message: /not greater than the current version 0\.3\.2/ },
    { name: 'a lower version', arrange: () => undefined, args: ['0.3.1'], message: /not greater/ },
    { name: 'a CHANGELOG without the heading', arrange: () => undefined, args: ['0.5.0'], message: /no "## \[0\.5\.0\]" heading/ },
    { name: 'a tag that exists', arrange: () => git('tag', 'v0.4.0'), args: ['0.4.0'], message: /tag v0\.4\.0 already exists/ },
    { name: 'a prerelease version', arrange: () => undefined, args: ['0.4.0-rc.1'], message: /not a version like 1\.2\.3/ },
    { name: 'no version', arrange: () => undefined, args: [], message: /Usage: pnpm release/ },
  ];

  for (const refusal of refusals) {
    it(`refuses ${refusal.name}, and changes nothing`, () => {
      refusal.arrange();
      const before = { head: head(), changelog: readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), pkg: readFileSync(path.join(repo, 'package.json'), 'utf8') };
      const result = run(...refusal.args);
      assert.equal(result.code, 1, result.out);
      assert.match(result.err, refusal.message);
      assert.equal(head(), before.head);
      assert.equal(readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), before.changelog);
      assert.equal(readFileSync(path.join(repo, 'package.json'), 'utf8'), before.pkg);
    });
  }

  it('`notes` prints one section of the CHANGELOG', () => {
    const result = run('notes', '0.3.2');
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, '### Fixed\n\n- Three.\n');
  });
});
