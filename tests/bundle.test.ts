/**
 * The published file: one dist/cli.mjs that runs from a folder with no
 * node_modules, and a package with no runtime dependencies. Builds first.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { fixtureDocument, makeTempEnv, snapshotTree, startFixtureServer, type FixtureServer, type TempEnv } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'cli.mjs');

type Spawned = { code: number; stdout: string; stderr: string };

function exitCodeOf(error: { code?: unknown } | null): number {
  if (error === null) return 0;
  if (typeof error.code === 'number') return error.code;
  return -1;
}

/** Runs the copied bundle with plain `node`, stdin a pipe (not a terminal). */
function runBundle(opts: { file: string; args: string[]; env: TempEnv }): Promise<Spawned> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [opts.file, ...opts.args],
      { cwd: opts.env.project, env: { PATH: opts.env.bin, HOME: opts.env.home }, timeout: 20_000 },
      (error, stdout, stderr) => {
        resolve({ code: exitCodeOf(error), stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

describe('the bundle', () => {
  let server: FixtureServer;
  let env: TempEnv;
  let copied: string;

  before(async () => {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: 'pipe' });
    server = await startFixtureServer({ document: (origin) => fixtureDocument({ origin }) });
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    env = makeTempEnv();
    copied = path.join(env.root, 'cli.mjs');
    copyFileSync(DIST, copied);
  });
  afterEach(() => {
    env.cleanup();
  });

  it('has no runtime dependencies and points bin at dist/cli.mjs', () => {
    assert.equal('dependencies' in packageJson, false);
    assert.deepEqual(packageJson.bin, { agentbuffs: 'dist/cli.mjs' });
    assert.deepEqual(packageJson.files, ['dist', 'README.md', 'LICENSE']);
  });

  it('starts with the node shebang and imports only node built-ins', () => {
    const text = readFileSync(DIST, 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'));
    const specifiers = [...text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1] ?? '');
    const external = specifiers.filter((specifier) => !specifier.startsWith('node:'));
    assert.deepEqual(external, []);
    console.log(`dist/cli.mjs: ${statSync(DIST).size} bytes`);
  });

  it('runs --version from a folder with no node_modules', async () => {
    const result = await runBundle({ file: copied, args: ['--version'], env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), packageJson.version);
  });

  it('runs a dry run for Cursor against the fixture server and writes nothing', async () => {
    const before = snapshotTree(env.root);
    const result = await runBundle({ file: copied, args: ['--dry-run', '--client', 'cursor', '--yes', '--api', server.origin], env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Cursor\n {4}MCP: create ~\/\.cursor\/mcp\.json/);
    assert.match(result.stdout, /Dry run: nothing was written\./);
    assert.deepEqual(snapshotTree(env.root), before);
    console.log(result.stdout);
  });

  it('without a terminal and without flags prints the plan and exits 2', async () => {
    const result = await runBundle({ file: copied, args: ['--api', server.origin], env });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /^Plan:/);
    assert.match(result.stderr, /No terminal to ask in/);
  });
});
