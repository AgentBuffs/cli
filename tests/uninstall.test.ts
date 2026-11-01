import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { removeArgsFor } from '../src/run-action.ts';
import type { RunAction } from '../src/setup-document.ts';
import { frontmatterName } from '../src/uninstall-plan.ts';
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

const CURSOR_ORIGINAL = '{\n  "mcpServers": {\n    "other": {\n      "url": "https://example.com/mcp"\n    }\n  },\n  "theme": "dark"\n}\n';
const CODEX_ORIGINAL = 'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n';
const VSCODE_ORIGINAL = '{\n  "servers": {\n    "mine": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}\n';

/** A fake `claude` that logs every call. `installed` holds the URL of the server it "has"; `fail-remove` makes remove fail. */
const FAKE_CLAUDE = `#!/bin/sh
dir="$(dirname "$0")"
printf '%s\\n' "$*" >> "$dir/claude.log"
if [ "$1" = mcp ] && [ "$2" = get ]; then
  if [ -f "$dir/installed" ]; then cat "$dir/installed"; exit 0; fi
  echo "No MCP server found with name: $3" >&2
  exit 1
fi
if [ "$1" = mcp ] && [ "$2" = remove ]; then
  if [ -f "$dir/fail-remove" ]; then echo "boom: config locked" >&2; exit 4; fi
  rm -f "$dir/installed"
  exit 0
fi
exit 3
`;

function api(server: FixtureServer): string[] {
  return ['--api', server.origin];
}

describe('uninstall against a fixture server on a temp HOME', () => {
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
    server.requests.length = 0;
  });
  afterEach(() => {
    env.cleanup();
  });

  const file = (...parts: string[]): string => path.join(env.home, ...parts);

  it('install then uninstall gives every config file back byte for byte, and removes the skill and its folder', async () => {
    writeFile(file('.cursor', 'mcp.json'), CURSOR_ORIGINAL);
    writeFile(file('.codex', 'config.toml'), CODEX_ORIGINAL);
    writeFile(path.join(env.project, '.vscode', 'mcp.json'), VSCODE_ORIGINAL);
    const clients = 'cursor,codex,vscode';
    const installed = await runCli({ env, argv: ['--client', clients, '--yes', ...api(server)] });
    assert.equal(installed.code, 0, installed.err);
    assert.notEqual(readText(file('.cursor', 'mcp.json')), CURSOR_ORIGINAL);
    assert.equal(readText(file('.codex', 'skills', 'find-agent-tools', 'SKILL.md')), SKILL_TEXT);

    const removed = await runCli({ env, argv: ['uninstall', '--client', clients, '--yes', ...api(server)] });
    assert.equal(removed.code, 0, removed.err);
    assert.equal(readText(file('.cursor', 'mcp.json')), CURSOR_ORIGINAL);
    assert.equal(readText(file('.codex', 'config.toml')), CODEX_ORIGINAL);
    assert.equal(readText(path.join(env.project, '.vscode', 'mcp.json')), VSCODE_ORIGINAL);
    assert.equal(existsSync(file('.codex', 'skills', 'find-agent-tools')), false, 'the empty skill folder goes');
    assert.equal(existsSync(file('.codex', 'skills')), true, 'the skills folder stays');
    assert.match(removed.out, /✓ Cursor +MCP server removed/);
    assert.match(removed.out, /✓ Codex +MCP server \+ skill removed/);
    assert.match(removed.out, /Restart Cursor, VS Code and Codex so it stops loading agentbuffs\./);
    assert.doesNotMatch(removed.out, /rate it/);
  });

  it('writes a .bak of each config first and lists them', async () => {
    writeFile(file('.cursor', 'mcp.json'), CURSOR_ORIGINAL);
    await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api(server)] });
    const installedText = readText(file('.cursor', 'mcp.json'));
    const result = await runCli({ env, argv: ['uninstall', '--client', 'cursor', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    const backups = readdirSync(file('.cursor')).filter((name) => name.endsWith('.bak'));
    assert.equal(backups.length, 2, 'one from the install, one from the uninstall');
    const copies = backups.map((name) => readText(file('.cursor', name)));
    assert.ok(copies.includes(installedText), 'a backup holds the file as it was before the removal');
    assert.match(result.out, /Backups: .*mcp\.json.*\.bak/);
  });

  it('leaves a file that install created as an empty-servers file, and does not delete it', async () => {
    await runCli({ env, argv: ['--client', 'cursor,codex', '--yes', ...api(server)] });
    const result = await runCli({ env, argv: ['uninstall', '--client', 'cursor,codex', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.equal(readText(file('.cursor', 'mcp.json')), '{}\n');
    assert.equal(readText(file('.codex', 'config.toml')), '');
  });

  it('says "not set up" for an absent entry and writes nothing', async () => {
    writeFile(file('.cursor', 'mcp.json'), CURSOR_ORIGINAL);
    const before = snapshotTree(env.root);
    const result = await runCli({ env, argv: ['uninstall', '--client', 'cursor,codex', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /• Cursor +not set up/);
    assert.match(result.out, /• Codex +not set up/);
    assert.match(result.out, /Nothing to remove\. agentbuffs was not set up\./);
    assert.deepEqual(snapshotTree(env.root), before, 'no write, no .bak');
    const dry = await runCli({ env, argv: ['uninstall', '--client', 'cursor', '--dry-run', ...api(server)] });
    assert.match(dry.out, /MCP {4}nothing to remove at ~\/\.cursor\/mcp\.json/);
  });

  it('removes an entry whose value was changed by hand', async () => {
    writeFile(file('.cursor', 'mcp.json'), '{\n  "mcpServers": {\n    "agentbuffs": {\n      "url": "https://old.example/mcp"\n    }\n  }\n}\n');
    const result = await runCli({ env, argv: ['uninstall', '--client', 'cursor', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.equal(readText(file('.cursor', 'mcp.json')), '{}\n');
  });

  it('leaves an edited skill in place, names the path, and still removes the MCP entry', async () => {
    await runCli({ env, argv: ['--client', 'codex', '--yes', ...api(server)] });
    const skill = file('.codex', 'skills', 'find-agent-tools', 'SKILL.md');
    const edited = `${SKILL_TEXT}\nMy own rule.\n`;
    writeFileSync(skill, edited);
    const result = await runCli({ env, argv: ['uninstall', '--client', 'codex', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.equal(readText(skill), edited);
    assert.match(result.out, /skill: edited or outdated, left in place: ~\/\.codex\/skills\/find-agent-tools\/SKILL\.md/);
    assert.doesNotMatch(readText(file('.codex', 'config.toml')), /agentbuffs/);
  });

  it('leaves a file whose name is not the skill name in place', async () => {
    const skill = file('.codex', 'skills', 'find-agent-tools', 'SKILL.md');
    writeFile(skill, '---\nname: something-else\n---\n\nOther.\n');
    const result = await runCli({ env, argv: ['uninstall', '--client', 'codex', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /skill: not the find-agent-tools skill, left in place/);
    assert.equal(existsSync(skill), true);
  });

  it('keeps the skill folder when anything else is in it', async () => {
    await runCli({ env, argv: ['--client', 'codex', '--yes', ...api(server)] });
    const folder = file('.codex', 'skills', 'find-agent-tools');
    writeFile(path.join(folder, 'notes.txt'), 'mine');
    const result = await runCli({ env, argv: ['uninstall', '--client', 'codex', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.equal(existsSync(path.join(folder, 'SKILL.md')), false);
    assert.equal(readText(path.join(folder, 'notes.txt')), 'mine');
  });

  it('asks the server once, and does not download the skill', async () => {
    await runCli({ env, argv: ['uninstall', '--client', 'cursor', '--yes', ...api(server)] });
    assert.deepEqual(server.requests, ['/api/discover/v1/setup']);
  });

  it('prints the manual removal steps for ChatGPT and a YAML client', async () => {
    const result = await runCli({ env, argv: ['uninstall', '--client', 'chatgpt,goose', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Remove by hand\n(?:.*\n)*? {2}ChatGPT\n {4}Delete the agentbuffs server from ChatGPT, where you added it\. The steps that added it:\n {6}Settings > Apps/);
    assert.match(result.out, /Docs: https:\/\/agentbuffs\.com\/clients\/chatgpt/);
    assert.match(result.out, / {4}Delete the agentbuffs entry under extensions in ~\/\.config\/goose\/config\.yaml\./);
    assert.match(result.out, /Follow the steps above to finish\./);
  });

  it('refuses a config file it cannot parse, names it, and leaves it alone', async () => {
    writeFile(file('.cursor', 'mcp.json'), '{ not json');
    const result = await runCli({ env, argv: ['uninstall', '--client', 'cursor', '--yes', ...api(server)] });
    assert.equal(result.code, 1);
    assert.match(result.out, /✗ Cursor +MCP: ~\/\.cursor\/mcp\.json was not changed: it is not valid JSON/);
    assert.equal(readText(file('.cursor', 'mcp.json')), '{ not json');
  });

  describe('without a terminal', () => {
    it('prints the plan and exits 2 without --client and --yes, and writes nothing', async () => {
      writeFile(file('.cursor', 'mcp.json'), CURSOR_ORIGINAL);
      await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api(server)] });
      const before = snapshotTree(env.root);
      for (const argv of [['uninstall'], ['uninstall', '--client', 'cursor'], ['uninstall', '--yes']]) {
        const result = await runCli({ env, argv: [...argv, ...api(server)] });
        assert.equal(result.code, 2, argv.join(' '));
        assert.match(result.err, /No terminal to ask in\. Run again with --client <slug,\.\.\.> --yes to remove/);
      }
      const planned = await runCli({ env, argv: ['uninstall', '--client', 'cursor', ...api(server)] });
      assert.match(planned.out, /Plan\n {2}Cursor {3}remove MCP server$/);
      assert.deepEqual(snapshotTree(env.root), before);
    });

    it('--dry-run prints the plan and every change, exits 0 and writes nothing', async () => {
      writeFile(file('.cursor', 'mcp.json'), CURSOR_ORIGINAL);
      await runCli({ env, argv: ['--client', 'cursor,codex', '--yes', ...api(server)] });
      const before = snapshotTree(env.root);
      const result = await runCli({ env, argv: ['uninstall', '--client', 'cursor,codex', '--dry-run', ...api(server)] });
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /Plan\n {2}Cursor {3}remove MCP server\n {2}Codex {4}remove MCP server \+ skill\n/);
      assert.match(result.out, /MCP {4}remove the agentbuffs entry in ~\/\.cursor\/mcp\.json, backup first\n {11}mcpServers\.agentbuffs/);
      assert.match(result.out, /skill {2}delete ~\/\.codex\/skills\/find-agent-tools\/SKILL\.md and its folder, if the folder is empty/);
      assert.match(result.out, /Dry run\. Nothing was written\./);
      assert.deepEqual(snapshotTree(env.root), before);
    });

    it('--client with --yes removes and exits 0', async () => {
      await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api(server)] });
      const result = await runCli({ env, argv: ['uninstall', '--client', 'cursor', '--yes', ...api(server)] });
      assert.equal(result.code, 0, result.err);
      assert.equal(readText(file('.cursor', 'mcp.json')), '{}\n');
    });

    it('--dry-run alone lists every agent slug', async () => {
      const result = await runCli({ env, argv: ['uninstall', '--dry-run', ...api(server)] });
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /Agents you can pass to --client\n/);
      assert.match(result.out, /^ *cursor +Cursor$/m);
    });
  });

  describe('in a terminal', () => {
    it('asks which agents, then asks to go ahead, and never asks about parts', async () => {
      writeFile(file('.cursor', 'mcp.json'), CURSOR_ORIGINAL);
      await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api(server)] });
      const result = await runCli({ env, argv: ['uninstall', ...api(server)], interactive: true, answers: { harnesses: ['cursor'], plan: ['install'] } });
      assert.equal(result.code, 0, result.err);
      assert.equal(result.asked.length, 2);
      assert.match(result.asked[0] ?? '', /^harnesses preselected=/);
      assert.equal(result.asked[1], 'plan details=true');
      assert.equal(readText(file('.cursor', 'mcp.json')), CURSOR_ORIGINAL);
    });

    it('writes nothing when the answer is cancel', async () => {
      await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api(server)] });
      const before = snapshotTree(env.root);
      const result = await runCli({ env, argv: ['uninstall', ...api(server)], interactive: true, answers: { harnesses: ['cursor'], plan: ['cancel'] } });
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /Nothing was removed\./);
      assert.deepEqual(snapshotTree(env.root), before);
    });

    it('shows the changes first on request', async () => {
      await runCli({ env, argv: ['--client', 'cursor', '--yes', ...api(server)] });
      const result = await runCli({ env, argv: ['uninstall', ...api(server)], interactive: true, answers: { harnesses: ['cursor'], plan: ['details', 'cancel'] } });
      assert.match(result.out, /Changes\n {2}Cursor\n {4}MCP {4}remove the agentbuffs entry in ~\/\.cursor\/mcp\.json, backup first/);
    });

    it('--yes with no --client uses the agents it finds, and exits 2 with none', async () => {
      const none = await runCli({ env, argv: ['uninstall', '--yes', ...api(server)], interactive: true });
      assert.equal(none.code, 2);
      assert.match(none.err, /No agent found\. Pick one with --client/);
    });
  });

  it('refuses --what, an unknown command and an extra word, exit 2', async () => {
    for (const argv of [['uninstall', '--what', 'mcp'], ['reinstall'], ['uninstall', 'cursor']]) {
      const result = await runCli({ env, argv: [...argv, ...api(server)] });
      assert.equal(result.code, 2, argv.join(' '));
    }
  });

  it('accepts `install` as the default command spelled out', async () => {
    const result = await runCli({ env, argv: ['install', '--client', 'cursor', '--dry-run', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Plan\n {2}Cursor {3}MCP server\n/);
  });

  it('lists the command in --help', async () => {
    const result = await runCli({ env, argv: ['--help'] });
    assert.match(result.out, /npx agentbuffs uninstall \[options\]/);
    assert.match(result.out, /--no-reports/);
  });
});

describe('uninstall with a skill path that several agents share', () => {
  let server: FixtureServer;
  let env: TempEnv;
  const SHARED = '~/.agents/skills/find-agent-tools/SKILL.md';

  before(async () => {
    server = await startFixtureServer({
      document: (origin) => {
        const doc = fixtureDocument({ origin });
        const shared = (slug: string, name: string): Record<string, unknown> => ({
          slug,
          name,
          detect: { commands: [], paths: [] },
          mcp: null,
          skill: { kind: 'file', path: SHARED },
        });
        return { ...doc, harnesses: [shared('pi', 'Pi'), shared('warp', 'Warp'), shared('zed', 'Zed')] };
      },
    });
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

  it('deletes the file once and reports every agent as done', async () => {
    const skill = path.join(env.home, '.agents', 'skills', 'find-agent-tools', 'SKILL.md');
    writeFile(skill, SKILL_TEXT);
    const dry = await runCli({ env, argv: ['uninstall', '--client', 'pi,warp', '--dry-run', ...api(server)] });
    assert.match(dry.out, /Pi\n {4}MCP {4}not offered for this agent\n {4}skill {2}delete ~\/\.agents\/skills\/find-agent-tools\/SKILL\.md and its folder, if the folder is empty\n {11}also used by Zed, which you did not pick/);
    assert.match(dry.out, /Warp\n {4}MCP {4}not offered for this agent\n {4}skill {2}delete .*\n {11}same file as Pi, deleted once/);

    const result = await runCli({ env, argv: ['uninstall', '--client', 'pi,warp', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.equal(existsSync(skill), false);
    assert.match(result.out, /✓ Pi +skill removed/);
    assert.match(result.out, /✓ Warp +skill removed/);
  });

  it('leaves an edited shared file in place for every agent that shares it', async () => {
    const skill = path.join(env.home, '.agents', 'skills', 'find-agent-tools', 'SKILL.md');
    writeFile(skill, `${SKILL_TEXT}mine\n`);
    const result = await runCli({ env, argv: ['uninstall', '--client', 'pi,warp', '--yes', ...api(server)] });
    assert.equal(result.code, 0, result.err);
    assert.equal(existsSync(skill), true);
    const done = result.out.slice(result.out.indexOf('Done'));
    assert.equal(done.match(/left in place/g)?.length, 2);
  });
});

describe('uninstall with a harness CLI on PATH', () => {
  let env: TempEnv;
  const logLines = (): string[] => (existsSync(path.join(env.bin, 'claude.log')) ? readFileSync(path.join(env.bin, 'claude.log'), 'utf8').trimEnd().split('\n') : []);

  beforeEach(() => {
    env = makeTempEnv();
    fakeCommand(env, { name: 'claude', script: FAKE_CLAUDE });
  });
  afterEach(() => {
    env.cleanup();
  });

  async function withServer<Result>(opts: { addArgs: string[]; run: (server: FixtureServer) => Promise<Result> }): Promise<Result> {
    const server = await startFixtureServer({
      document: (origin) => {
        const doc = fixtureDocument({ origin });
        const claude = { slug: 'claude-code', name: 'Claude Code', detect: { commands: ['claude'] }, mcp: { kind: 'run', command: 'claude', args: opts.addArgs }, skill: null };
        return { ...doc, harnesses: [claude] };
      },
    });
    try {
      return await opts.run(server);
    } finally {
      await server.close();
    }
  }

  it('runs `claude mcp remove` with the scope the install used, after asking claude whether the server is there', async () => {
    writeFileSync(path.join(env.bin, 'installed'), `URL: ${MCP_URL}\n`);
    await withServer({
      addArgs: ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'agentbuffs', MCP_URL],
      run: async (server) => {
        const result = await runCli({ env, argv: ['uninstall', '--client', 'claude-code', '--yes', ...api(server)] });
        assert.equal(result.code, 0, result.err);
        assert.match(result.out, /✓ Claude Code +MCP server removed/);
      },
    });
    assert.deepEqual(logLines(), ['mcp get agentbuffs', 'mcp remove agentbuffs --scope user']);
    assert.equal(existsSync(path.join(env.bin, 'installed')), false);
  });

  it('says "not set up" and does not run remove when claude does not know the server', async () => {
    await withServer({
      addArgs: ['mcp', 'add', '--transport', 'http', 'agentbuffs', MCP_URL],
      run: async (server) => {
        const result = await runCli({ env, argv: ['uninstall', '--client', 'claude-code', '--yes', ...api(server)] });
        assert.equal(result.code, 0, result.err);
        assert.match(result.out, /• Claude Code +not set up/);
      },
    });
    assert.deepEqual(logLines(), ['mcp get agentbuffs']);
  });

  it("reports the harness CLI's own output when the remove fails", async () => {
    writeFileSync(path.join(env.bin, 'installed'), `URL: ${MCP_URL}\n`);
    writeFileSync(path.join(env.bin, 'fail-remove'), '');
    await withServer({
      addArgs: ['mcp', 'add', '--transport', 'http', 'agentbuffs', MCP_URL],
      run: async (server) => {
        const result = await runCli({ env, argv: ['uninstall', '--client', 'claude-code', '--yes', ...api(server)] });
        assert.equal(result.code, 1);
        assert.match(result.out, /✗ Claude Code +MCP: claude failed, exit code 4: boom: config locked/);
      },
    });
  });

  it('shows the remove command in the dry run and runs nothing', async () => {
    await withServer({
      addArgs: ['mcp', 'add', '--scope', 'project', '--transport', 'http', 'agentbuffs', MCP_URL],
      run: async (server) => {
        const result = await runCli({ env, argv: ['uninstall', '--client', 'claude-code', '--dry-run', ...api(server)] });
        assert.equal(result.code, 0, result.err);
        assert.match(result.out, /run claude mcp remove agentbuffs --scope project/);
      },
    });
    assert.deepEqual(logLines(), []);
  });

  it('refuses a scope it does not know and never runs claude', async () => {
    await withServer({
      addArgs: ['mcp', 'add', '--scope', '$(id)', '--transport', 'http', 'agentbuffs', MCP_URL],
      run: async (server) => {
        const result = await runCli({ env, argv: ['uninstall', '--client', 'claude-code', '--yes', ...api(server)] });
        assert.equal(result.code, 1);
        assert.match(result.out, /✗ Claude Code +MCP: the (scope|argument) /);
      },
    });
    assert.deepEqual(logLines(), []);
  });

  it('gives manual steps for a CLI that has no remove command in the allowlist, and runs nothing', async () => {
    fakeCommand(env, { name: 'copilot', script: `#!/bin/sh\ntouch "$(dirname "$0")/copilot-ran"\n` });
    const server = await startFixtureServer({
      document: (origin) => ({
        ...fixtureDocument({ origin }),
        harnesses: [{ slug: 'copilot-cli', name: 'GitHub Copilot CLI', detect: { commands: ['copilot'] }, mcp: { kind: 'run', command: 'copilot', args: ['mcp', 'add', 'agentbuffs', MCP_URL] }, skill: null }],
      }),
    });
    try {
      const result = await runCli({ env, argv: ['uninstall', '--client', 'copilot-cli', '--yes', ...api(server)] });
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /This version has no remove command for copilot\. Remove the agentbuffs MCP server from GitHub Copilot CLI by hand\./);
      assert.equal(existsSync(path.join(env.bin, 'copilot-ran')), false);
    } finally {
      await server.close();
    }
  });

  it('refuses a claude missing from PATH', async () => {
    await withServer({
      addArgs: ['mcp', 'add', '--transport', 'http', 'agentbuffs', MCP_URL],
      run: async (server) => {
        const bare = makeTempEnv();
        try {
          const result = await runCli({ env: bare, argv: ['uninstall', '--client', 'claude-code', '--yes', ...api(server)] });
          assert.equal(result.code, 1);
          assert.match(result.out, /claude not found on PATH/);
        } finally {
          bare.cleanup();
        }
      },
    });
  });
});

describe('removeArgsFor', () => {
  const add = (args: string[], command = 'claude'): RunAction => ({ kind: 'run', command, args });

  it('builds the remove argv from the local table, with only a known scope taken from the add', () => {
    assert.deepEqual(removeArgsFor(add(['mcp', 'add', '--scope', 'local', 'agentbuffs', MCP_URL]), 'agentbuffs'), ['mcp', 'remove', 'agentbuffs', '--scope', 'local']);
    assert.deepEqual(removeArgsFor(add(['mcp', 'add', '--scope=project', 'agentbuffs', MCP_URL]), 'agentbuffs'), ['mcp', 'remove', 'agentbuffs', '--scope', 'project']);
    assert.deepEqual(removeArgsFor(add(['mcp', 'add', 'agentbuffs', MCP_URL], 'codex'), 'agentbuffs'), ['mcp', 'remove', 'agentbuffs']);
    assert.deepEqual(removeArgsFor(add(['mcp', 'add', 'agentbuffs', '--url', MCP_URL], 'pi'), 'agentbuffs'), ['mcp', 'remove', 'agentbuffs']);
  });

  it('never copies any other word of the add command', () => {
    const args = removeArgsFor(add(['mcp', 'add', '--evil', 'x', '--scope', 'user', 'agentbuffs', MCP_URL]), 'agentbuffs');
    assert.deepEqual(args, ['mcp', 'remove', 'agentbuffs', '--scope', 'user']);
  });

  it('returns null for a CLI without a known remove command', () => {
    for (const command of ['code', 'copilot', 'grok', 'goose']) assert.equal(removeArgsFor(add(['mcp', 'add'], command), 'agentbuffs'), null, command);
  });

  it('throws for a scope that is not one of the three', () => {
    assert.throws(() => removeArgsFor(add(['mcp', 'add', '--scope', 'galaxy']), 'agentbuffs'), /scope "galaxy" is not one this CLI knows/);
    assert.throws(() => removeArgsFor(add(['mcp', 'add', '--scope']), 'agentbuffs'), /scope undefined/);
  });
});

describe('frontmatterName', () => {
  it('reads the name from the block at the top, with or without quotes', () => {
    assert.equal(frontmatterName(SKILL_TEXT), 'find-agent-tools');
    assert.equal(frontmatterName('---\r\nname: "find-agent-tools"\r\n---\r\nx'), 'find-agent-tools');
    assert.equal(frontmatterName("---\ndescription: a\nname: 'x y'\n---\n"), 'x y');
  });

  it('returns null without a block or without a name', () => {
    assert.equal(frontmatterName('# title\nname: find-agent-tools\n'), null);
    assert.equal(frontmatterName('---\ndescription: a\n---\nname: find-agent-tools\n'), null);
  });
});
