import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { parseSetupDocument } from '../src/setup-document.ts';
import {
  MCP_URL,
  SKILL_TEXT,
  fakeCommand,
  fixtureDocument,
  makeTempEnv,
  readText,
  runCli,
  sha256,
  snapshotTree,
  startFixtureServer,
  writeFile,
  type FixtureServer,
  type TempEnv,
} from './helpers.ts';

describe('parseSetupDocument', () => {
  it('accepts the fixture document', () => {
    const doc = parseSetupDocument(fixtureDocument({ origin: 'http://127.0.0.1:1' }));
    assert.equal(doc.harnesses.length, 6);
    assert.equal(doc.harnesses[0]?.mcp?.kind, 'run');
  });

  it('refuses an unknown setupVersion with an update message', () => {
    assert.throws(() => parseSetupDocument({ ...fixtureDocument({ origin: 'http://x' }), setupVersion: 2 }), /Update agentbuffs: run `npx agentbuffs@latest`/);
  });

  it('refuses a wrong shape with the field path', () => {
    const doc = fixtureDocument({ origin: 'http://x' });
    assert.throws(() => parseSetupDocument({ ...doc, mcpUrl: 'ftp://x' }), /mcpUrl must be an http or https URL/);
    assert.throws(() => parseSetupDocument({ ...doc, harnesses: [{ slug: 'x', name: 'X', mcp: { kind: 'run', command: 'claude', args: 'mcp add' } }] }), /harnesses\[0\]\.mcp\.args must be an array/);
  });

  it('keeps an action kind it does not know as unsupported', () => {
    const doc = parseSetupDocument({ ...fixtureDocument({ origin: 'http://x' }), harnesses: [{ slug: 'x', name: 'X', mcp: { kind: 'plist-merge', path: '~/x' } }] });
    assert.deepEqual(doc.harnesses[0]?.mcp, { kind: 'unsupported', originalKind: 'plist-merge' });
  });
});

describe('the CLI against a fixture server on a temp HOME', () => {
  let server: FixtureServer;
  let env: TempEnv;

  before(async () => {
    server = await startFixtureServer({ document: (origin) => fixtureDocument({ origin }) });
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    env = makeTempEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  const api = (): string[] => ['--api', server.origin];

  it('--dry-run writes nothing, even with --yes', async () => {
    fakeCommand(env, { name: 'claude', script: '#!/bin/sh\ntouch "$(dirname "$0")/claude-ran"\n' });
    writeFile(path.join(env.home, '.cursor', 'mcp.json'), '{\n  "other": 1\n}\n');
    writeFile(path.join(env.home, '.codex', 'config.toml'), 'model = "o4"\n');
    const before = snapshotTree(env.root);
    const result = await runCli({ env, argv: ['--client', 'claude-code,cursor,vscode,codex', '--dry-run', '--yes', ...api()] });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(snapshotTree(env.root), before);
    assert.match(result.out, /Plan\n {2}Claude Code {3}MCP server \+ skill\n {2}Cursor {8}MCP server\n/);
    assert.match(result.out, /MCP {4}run claude mcp add --transport http agentbuffs https:\/\/agentbuffs\.com\/api\/mcp/);
    assert.match(result.out, /Dry run\. Nothing was written\./);
  });

  it('without a terminal and without --client and --yes, prints the plan and exits 2', async () => {
    mkdirSync(path.join(env.home, '.cursor'));
    const before = snapshotTree(env.root);
    const result = await runCli({ env, argv: api() });
    assert.equal(result.code, 2);
    assert.match(result.out, /Plan\n {2}Cursor {3}MCP server$/m);
    assert.doesNotMatch(result.out, /mcp\.json/, 'the compact plan names no paths');
    assert.match(result.err, /No terminal to ask in/);
    assert.deepEqual(snapshotTree(env.root), before);

    const withClientOnly = await runCli({ env, argv: ['--client', 'cursor', ...api()] });
    assert.equal(withClientOnly.code, 2);
    const withYesOnly = await runCli({ env, argv: ['--yes', ...api()] });
    assert.equal(withYesOnly.code, 2);
    assert.deepEqual(snapshotTree(env.root), before);
  });

  it('lists the harnesses it finds first, preselected and marked found', async () => {
    mkdirSync(path.join(env.home, '.cursor'));
    fakeCommand(env, { name: 'codex', script: '#!/bin/sh\nexit 0\n' });
    const result = await runCli({ env, argv: api(), interactive: true, answers: { harnesses: ['cursor'], plan: ['cancel'] } });
    assert.equal(result.code, 0, result.err);
    assert.match(result.asked[0] ?? '', /^harnesses preselected=cursor,codex choices=cursor\(found\),codex\(found\),claude-code\(\)/);
    assert.match(result.out, /Nothing was written\./);
  });

  describe('--yes in a terminal asks nothing', () => {
    it('installs both parts for --client with no --what, and asks no question', async () => {
      const result = await runCli({ env, argv: ['--client', 'codex', '--yes', ...api()], interactive: true });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(result.asked, []);
      assert.match(readText(path.join(env.home, '.codex', 'config.toml')), /\[mcp_servers\.agentbuffs\]/);
      assert.equal(readText(path.join(env.home, '.codex', 'skills', 'find-agent-tools', 'SKILL.md')), SKILL_TEXT);
    });

    it('still honours --what', async () => {
      const result = await runCli({ env, argv: ['--client', 'codex', '--what', 'mcp', '--yes', ...api()], interactive: true });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(result.asked, []);
      assert.equal(existsSync(path.join(env.home, '.codex', 'skills')), false);
    });

    it('takes the agents it finds when there is no --client, without asking which', async () => {
      mkdirSync(path.join(env.home, '.cursor'));
      mkdirSync(path.join(env.home, '.codex'));
      const result = await runCli({ env, argv: ['--yes', ...api()], interactive: true });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(result.asked, []);
      assert.match(readText(path.join(env.home, '.cursor', 'mcp.json')), /agentbuffs/);
      assert.match(readText(path.join(env.home, '.codex', 'config.toml')), /agentbuffs/);
    });

    it('exits 2 with the known slugs when there is no --client and no agent is found, and writes nothing', async () => {
      const before = snapshotTree(env.root);
      const result = await runCli({ env, argv: ['--yes', ...api()], interactive: true });
      assert.equal(result.code, 2);
      assert.deepEqual(result.asked, []);
      assert.match(result.err, /No agent found\. Pick one with --client: claude-code, cursor/);
      assert.deepEqual(snapshotTree(env.root), before);
    });

    it('replaces a different existing entry without asking', async () => {
      writeFile(path.join(env.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { agentbuffs: { url: 'https://old.example' } } }));
      const result = await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api()], interactive: true });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(result.asked, []);
      assert.match(readText(path.join(env.home, '.cursor', 'mcp.json')), /agentbuffs\.com\/api\/mcp/);
    });

    it('without --yes the parts question is still asked', async () => {
      const result = await runCli({ env, argv: ['--client', 'codex', ...api()], interactive: true, answers: { what: 'mcp', plan: ['install'] } });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(result.asked, ['what', 'plan details=true']);
    });
  });

  it('shows the changes on request, asks again without that choice, and writes nothing on cancel', async () => {
    mkdirSync(path.join(env.home, '.cursor'));
    const before = snapshotTree(env.root);
    const result = await runCli({ env, argv: api(), interactive: true, answers: { harnesses: ['cursor'], plan: ['details', 'cancel'] } });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(result.asked.slice(1), ['plan details=true', 'plan details=false']);
    assert.match(result.out, /Plan\n {2}Cursor {3}MCP server\n\nChanges\n {2}Cursor\n {4}MCP {4}create ~\/\.cursor\/mcp\.json\n {11}mcpServers\.agentbuffs = /);
    assert.match(result.out, /Nothing was written\./);
    assert.deepEqual(snapshotTree(env.root), before);
  });

  it('--verbose shows the changes before it asks', async () => {
    mkdirSync(path.join(env.home, '.cursor'));
    const result = await runCli({ env, argv: ['--verbose', ...api()], interactive: true, answers: { harnesses: ['cursor'], plan: ['install'] } });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(result.asked.slice(1), ['plan details=false']);
    assert.ok(result.out.indexOf('Changes') < result.out.indexOf('✓ Cursor'), result.out);
  });

  for (const where of ['harnesses', 'what', 'plan', 'replace'] as const) {
    it(`Ctrl+C at the ${where} question exits 130 and writes nothing`, async () => {
      writeFile(path.join(env.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { agentbuffs: { url: 'https://old.example' } } }));
      const before = snapshotTree(env.root);
      const answers = {
        harnesses: where === 'harnesses' ? ('cancel' as const) : ['cursor', 'codex'],
        what: where === 'what' ? ('cancel' as const) : ('both' as const),
        plan: where === 'plan' ? ['ctrl-c' as const] : ['install' as const],
        confirms: ['cancel' as const],
      };
      const result = await runCli({ env, argv: api(), interactive: true, answers });
      assert.equal(result.code, 130);
      assert.match(result.err, /Cancelled\. Nothing was written\./);
      assert.deepEqual(snapshotTree(env.root), before);
    });
  }

  it('writes the skill file after checking its sha256, and is idempotent', async () => {
    const skillFile = path.join(env.home, '.codex', 'skills', 'find-agent-tools', 'SKILL.md');
    const first = await runCli({ env, argv: ['--client', 'codex', '--what', 'skill', '--yes', ...api()] });
    assert.equal(first.code, 0, first.err);
    assert.equal(readText(skillFile), SKILL_TEXT);
    assert.match(first.out, /✓ Codex +skill\n/);
    const second = await runCli({ env, argv: ['--client', 'codex', '--what', 'skill', '--yes', ...api()] });
    assert.match(second.out, /• Codex +already set up/);
  });

  it('shows manual steps with the docs link, YAML as a snippet, and an unknown kind as an update hint', async () => {
    const result = await runCli({ env, argv: ['--client', 'chatgpt,goose', '--dry-run', ...api()] });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Create app\n.*URL: https:\/\/agentbuffs\.com\/api\/mcp\n.*Docs: https:\/\/agentbuffs\.com\/clients\/chatgpt/);
    assert.match(result.out, /Add this to ~\/\.config\/goose\/config\.yaml:\n\s+extensions:\n\s+ agentbuffs:\n\s+ name: "agentbuffs"/);
  });

  it('refuses an unknown --client with the known slugs, exit 2', async () => {
    const result = await runCli({ env, argv: ['--client', 'nope', '--yes', ...api()] });
    assert.equal(result.code, 2);
    assert.match(result.err, /Unknown --client nope\. Known: claude-code, cursor/);
  });

  it('refuses an unknown flag, exit 2', async () => {
    const result = await runCli({ env, argv: ['--force'] });
    assert.equal(result.code, 2);
  });
});

describe('the CLI when the server or the document is wrong', () => {
  let env: TempEnv;

  beforeEach(() => {
    env = makeTempEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('exits 1 with an update message for a newer setupVersion', async () => {
    const server = await startFixtureServer({ document: (origin) => ({ ...fixtureDocument({ origin }), setupVersion: 2 }) });
    try {
      const result = await runCli({ env, argv: ['--client', 'cursor', '--yes', '--api', server.origin] });
      assert.equal(result.code, 1);
      assert.match(result.err, /setup version 2.*Update agentbuffs/);
    } finally {
      await server.close();
    }
  });

  it('exits 1 with a clear message when the server cannot be reached', async () => {
    const server = await startFixtureServer({ document: () => ({}) });
    const origin = server.origin;
    await server.close();
    const result = await runCli({ env, argv: ['--client', 'cursor', '--yes', '--api', origin] });
    assert.equal(result.code, 1);
    assert.match(result.err, /Could not reach http:\/\/127\.0\.0\.1:\d+\/api\/discover\/v1\/setup/);
  });

  it('gives up after 5 seconds', async () => {
    const server = await startFixtureServer({ document: (origin) => fixtureDocument({ origin }), delayMs: 8_000 });
    try {
      const started = Date.now();
      const result = await runCli({ env, argv: ['--client', 'cursor', '--yes', '--api', server.origin] });
      const elapsed = Date.now() - started;
      assert.equal(result.code, 1);
      assert.match(result.err, /no answer within the time limit/);
      assert.ok(elapsed >= 4_900 && elapsed < 7_000, `took ${elapsed} ms`);
    } finally {
      await server.close();
    }
  });

  it('refuses a skill file whose sha256 does not match, and still does the MCP part', async () => {
    const server = await startFixtureServer({ document: (origin) => fixtureDocument({ origin, skillSha: sha256('other text') }) });
    try {
      const result = await runCli({ env, argv: ['--client', 'codex', '--yes', '--api', server.origin] });
      assert.equal(result.code, 1);
      assert.match(result.out, /✗ Codex +MCP server \(skill: The skill file at \S+ does not match its checksum\)\n/);
      assert.equal(existsSync(path.join(env.home, '.codex', 'skills')), false);
      assert.match(readText(path.join(env.home, '.codex', 'config.toml')), /\[mcp_servers\.agentbuffs\]/);
    } finally {
      await server.close();
    }
  });

  it('writes a skill file shared by two harnesses once, and the second says already there', async () => {
    const shared = '~/.agents/skills/find-agent-tools/SKILL.md';
    const server = await startFixtureServer({
      document: (origin) => ({
        ...fixtureDocument({ origin }),
        harnesses: [
          { slug: 'codex', name: 'Codex', detect: {}, mcp: null, skill: { kind: 'file', path: shared } },
          { slug: 'pi', name: 'Pi', detect: {}, mcp: null, skill: { kind: 'file', path: shared } },
        ],
      }),
    });
    try {
      const result = await runCli({ env, argv: ['--client', 'codex,pi', '--what', 'skill', '--yes', '--api', server.origin] });
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /✓ Codex +skill\n +• Pi +already set up/);
      assert.equal(readText(path.join(env.home, '.agents', 'skills', 'find-agent-tools', 'SKILL.md')), SKILL_TEXT);
    } finally {
      await server.close();
    }
  });

  it('refuses write paths outside the home folder and the project', async () => {
    const outside = path.join(env.root, 'outside.md');
    const server = await startFixtureServer({
      document: (origin) => ({
        ...fixtureDocument({ origin }),
        harnesses: [
          { slug: 'up', name: 'Up', detect: {}, mcp: null, skill: { kind: 'file', path: '~/../outside.md' } },
          { slug: 'abs', name: 'Abs', detect: {}, mcp: { kind: 'json-merge', path: outside, keyPath: ['a'], value: MCP_URL }, skill: null },
        ],
      }),
    });
    try {
      const result = await runCli({ env, argv: ['--client', 'up,abs', '--yes', '--api', server.origin] });
      assert.equal(result.code, 1);
      assert.match(result.out, /✗ Up +skill: ~\/\.\.\/outside\.md resolves to .*outside your home folder and this project/);
      assert.match(result.out, /✗ Abs +MCP: .*outside your home folder and this project/);
      assert.equal(existsSync(outside), false);
    } finally {
      await server.close();
    }
  });

  it('refuses a symlink that points out of the home folder', async () => {
    mkdirSync(path.join(env.home, '.cursor'));
    symlinkSync(env.root, path.join(env.home, '.cursor', 'escape'));
    const server = await startFixtureServer({
      document: (origin) => ({
        ...fixtureDocument({ origin }),
        harnesses: [{ slug: 'cursor', name: 'Cursor', detect: {}, mcp: { kind: 'json-merge', path: '~/.cursor/escape/mcp.json', keyPath: ['a'], value: MCP_URL }, skill: null }],
      }),
    });
    try {
      const result = await runCli({ env, argv: ['--client', 'cursor', '--yes', '--api', server.origin] });
      assert.equal(result.code, 1);
      assert.equal(existsSync(path.join(env.root, 'mcp.json')), false);
    } finally {
      await server.close();
    }
  });
});
