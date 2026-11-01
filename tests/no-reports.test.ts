import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { mentionsUrl } from '../src/run-action.ts';
import { chooseScreenMode } from '../src/screen-mode.ts';
import { MCP_URL, SKILL_TEXT, fakeCommand, fixtureDocument, makeTempEnv, readText, runCli, sha256, startFixtureServer, writeFile, type FixtureServer, type TempEnv } from './helpers.ts';

const OFF_URL = `${MCP_URL}?reports=off`;
const OFF_SKILL = SKILL_TEXT.replace('Ask agentbuffs.', 'Ask agentbuffs. Do not send reports.');

/** A stub of the server: `?reports=off` gets another MCP URL and a skill variant with its own sha256. */
function reportsAwareServer(): Promise<FixtureServer> {
  return startFixtureServer({
    document: (origin, search) =>
      search === '?reports=off'
        ? fixtureDocument({ origin, mcpUrl: OFF_URL, skillSha: sha256(OFF_SKILL), skillQuery: '?reports=off' })
        : fixtureDocument({ origin }),
    skillText: (search) => (search === '?reports=off' ? OFF_SKILL : SKILL_TEXT),
  });
}

describe('--no-reports', () => {
  let server: FixtureServer;
  let env: TempEnv;

  before(async () => {
    server = await reportsAwareServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    env = makeTempEnv();
    server.requests.length = 0;
  });
  afterEach(() => {
    env.cleanup();
  });

  const api = (): string[] => ['--api', server.origin];
  const cursorFile = (): string => path.join(env.home, '.cursor', 'mcp.json');

  it('fetches the setup document with ?reports=off and writes what it gets: the URL and the skill variant', async () => {
    const result = await runCli({ env, argv: ['--client', 'cursor,codex', '--no-reports', '--yes', ...api()] });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(server.requests, ['/api/discover/v1/setup?reports=off', '/api/discover/v1/setup/skill.md?reports=off']);
    assert.match(readText(cursorFile()), /"url": "https:\/\/agentbuffs\.com\/api\/mcp\?reports=off"/);
    assert.match(readText(path.join(env.home, '.codex', 'config.toml')), /url = "https:\/\/agentbuffs\.com\/api\/mcp\?reports=off"/);
    assert.equal(readText(path.join(env.home, '.codex', 'skills', 'find-agent-tools', 'SKILL.md')), OFF_SKILL);
  });

  it('asks for the plain document without the flag', async () => {
    await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api()] });
    assert.deepEqual(server.requests, ['/api/discover/v1/setup']);
    assert.doesNotMatch(readText(cursorFile()), /reports/);
  });

  it('shows "Reports: off" in the plan, and only with the flag', async () => {
    const off = await runCli({ env, argv: ['--client', 'cursor', '--no-reports', '--dry-run', ...api()] });
    assert.match(off.out, /Plan\n {2}Cursor {3}MCP server\n\n {2}Reports: off\n/);
    const on = await runCli({ env, argv: ['--client', 'cursor', '--dry-run', ...api()] });
    assert.doesNotMatch(on.out, /Reports/);
  });

  it('leaves out the line about rating tools on the Done screen, and keeps it without the flag', async () => {
    const off = await runCli({ env, argv: ['--client', 'cursor', '--no-reports', '--yes', ...api()] });
    assert.match(off.out, /Restart Cursor, then ask your agent:/);
    assert.doesNotMatch(off.out, /rate/);
    const other = makeTempEnv();
    try {
      const on = await runCli({ env: other, argv: ['--client', 'cursor', '--yes', ...api()] });
      assert.match(on.out, /After your agent installs a tool, it can rate it on agentbuffs\.com\./);
    } finally {
      other.cleanup();
    }
  });

  it('asks the normal replace question when the existing entry differs only by ?reports=off', async () => {
    writeFile(cursorFile(), JSON.stringify({ mcpServers: { agentbuffs: { url: MCP_URL } } }));
    const result = await runCli({
      env,
      argv: ['--client', 'cursor', '--no-reports', ...api()],
      interactive: true,
      answers: { what: 'mcp', plan: ['install'], confirms: [true] },
    });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(result.asked.slice(-2), ['plan details=true', 'Cursor already has a different agentbuffs entry. Replace it?']);
    assert.match(readText(cursorFile()), /\?reports=off/);
  });

  it('keeps the entry when that question is answered no', async () => {
    writeFile(cursorFile(), JSON.stringify({ mcpServers: { agentbuffs: { url: MCP_URL } } }));
    const result = await runCli({
      env,
      argv: ['--client', 'cursor', '--no-reports', ...api()],
      interactive: true,
      answers: { what: 'mcp', plan: ['install'], confirms: [false] },
    });
    assert.equal(result.code, 0, result.err);
    assert.doesNotMatch(readText(cursorFile()), /reports/);
    assert.match(result.out, /kept the existing entry/);
  });

  it('--yes replaces a ?reports=off entry with the plain one, without asking', async () => {
    writeFile(cursorFile(), JSON.stringify({ mcpServers: { agentbuffs: { url: OFF_URL } } }));
    const result = await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api()], interactive: true });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(result.asked, []);
    assert.doesNotMatch(readText(cursorFile()), /reports/);
  });

  it('uninstall --no-reports removes the skill variant an install --no-reports wrote; without the flag it leaves it', async () => {
    await runCli({ env, argv: ['--client', 'codex', '--no-reports', '--yes', ...api()] });
    const skill = path.join(env.home, '.codex', 'skills', 'find-agent-tools', 'SKILL.md');
    const plain = await runCli({ env, argv: ['uninstall', '--client', 'codex', '--yes', ...api()] });
    assert.equal(plain.code, 0, plain.err);
    assert.equal(existsSync(skill), true, 'the variant is not the plain skill, so it stays');
    assert.match(plain.out, /skill: edited or outdated, left in place/);
    const matching = await runCli({ env, argv: ['uninstall', '--client', 'codex', '--no-reports', '--yes', ...api()] });
    assert.equal(matching.code, 0, matching.err);
    assert.equal(existsSync(skill), false);
    assert.equal(server.requests.at(-1), '/api/discover/v1/setup?reports=off');
  });

  it('chooses the same screen as without the flag', () => {
    const facts = { isStdinTty: true, isStdoutTty: true, colorBits: 24, size: { columns: 100, rows: 40 }, env: {} };
    assert.equal(chooseScreenMode({ ...facts, argv: ['--no-reports'] }), 'fullscreen');
    assert.equal(chooseScreenMode({ ...facts, argv: ['uninstall'] }), 'terminal');
  });
});

describe('--no-reports against a harness CLI that already has the plain entry', () => {
  let env: TempEnv;
  let server: FixtureServer;

  beforeEach(async () => {
    env = makeTempEnv();
    fakeCommand(env, {
      name: 'claude',
      script: `#!/bin/sh\ndir="$(dirname "$0")"\nprintf '%s\\n' "$*" >> "$dir/claude.log"\nif [ "$2" = get ]; then cat "$dir/installed"; exit 0; fi\nexit 0\n`,
    });
    server = await reportsAwareServer();
  });
  afterEach(async () => {
    await server.close();
    env.cleanup();
  });

  it('does not take the plain URL for the ?reports=off URL (or the other way round) as "already there"', async () => {
    writeFileSync(path.join(env.bin, 'installed'), `agentbuffs:\n  Type: http\n  URL: ${MCP_URL}\n`);
    const off = await runCli({ env, argv: ['--client', 'claude-code', '--what', 'mcp', '--no-reports', '--yes', '--api', server.origin] });
    assert.match(off.out, /MCP: a different agentbuffs entry is there, run `claude mcp remove agentbuffs` and try again/);

    writeFileSync(path.join(env.bin, 'installed'), `agentbuffs:\n  Type: http\n  URL: ${OFF_URL}\n`);
    const plain = await runCli({ env, argv: ['--client', 'claude-code', '--what', 'mcp', '--yes', '--api', server.origin] });
    assert.match(plain.out, /MCP: a different agentbuffs entry is there/);
    const log = existsSync(path.join(env.bin, 'claude.log')) ? readFileSync(path.join(env.bin, 'claude.log'), 'utf8') : '';
    assert.doesNotMatch(log, /mcp add/);
  });
});

describe('mentionsUrl', () => {
  it('matches the URL as a whole word', () => {
    assert.equal(mentionsUrl(`URL: ${MCP_URL}\n`, MCP_URL), true);
    assert.equal(mentionsUrl(`"url": "${MCP_URL}",`, MCP_URL), true);
    assert.equal(mentionsUrl(`URL: ${OFF_URL}\n`, MCP_URL), false);
    assert.equal(mentionsUrl(`URL: ${MCP_URL}\n`, OFF_URL), false);
    assert.equal(mentionsUrl('', MCP_URL), false);
  });
});
