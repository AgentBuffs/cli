import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { RUN_ALLOWLIST, RunRefusedError, assertRunAllowed } from '../src/run-action.ts';
import type { RunAction } from '../src/setup-document.ts';
import {
  MCP_URL,
  fakeCommand,
  fixtureDocument,
  makeTempEnv,
  runCli,
  startFixtureServer,
  type TempEnv,
} from './helpers.ts';

const ADD: RunAction = { kind: 'run', command: 'claude', args: ['mcp', 'add', '--transport', 'http', 'agentbuffs', MCP_URL] };

describe('assertRunAllowed', () => {
  it('accepts the Claude Code add command', () => {
    assert.doesNotThrow(() => assertRunAllowed(ADD, MCP_URL));
  });

  it('allows exactly the hard-coded harness commands', () => {
    assert.deepEqual([...RUN_ALLOWLIST], ['claude', 'codex', 'gemini', 'code', 'copilot', 'pi', 'grok', 'goose']);
  });

  it('refuses a command outside the allowlist', () => {
    for (const command of ['bash', 'sh', 'rm', 'node', '/usr/bin/claude', 'claude.cmd', 'npx']) {
      assert.throws(() => assertRunAllowed({ ...ADD, command }, MCP_URL), RunRefusedError, command);
    }
  });

  it('refuses arguments without the MCP URL', () => {
    assert.throws(() => assertRunAllowed({ ...ADD, args: ['mcp', 'add', 'agentbuffs', 'https://evil.example/mcp'] }, MCP_URL), /do not contain/);
  });

  it('refuses an argument that starts with a shell metacharacter or holds a line break', () => {
    for (const bad of [';rm -rf ~', '$(id)', '`id`', '|cat', '&x', '>out', '<in', '~/x', ' leading', 'a\nb', '']) {
      assert.throws(() => assertRunAllowed({ ...ADD, args: [...ADD.args, bad] }, MCP_URL), /is not allowed/, JSON.stringify(bad));
    }
  });
});

const FAKE_CLAUDE = `#!/bin/sh
dir="$(dirname "$0")"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$dir/claude.log"; done
printf -- '--\\n' >> "$dir/claude.log"
if [ "$1" = mcp ] && [ "$2" = get ]; then
  if [ -f "$dir/installed" ]; then cat "$dir/installed"; exit 0; fi
  echo "No MCP server found with name: $3" >&2
  exit 1
fi
if [ "$1" = mcp ] && [ "$2" = add ]; then
  if [ -f "$dir/fail" ]; then echo "boom: config locked" >&2; exit 4; fi
  printf '%s\\n' "$6" > "$dir/installed"
  exit 0
fi
exit 3
`;

describe('run through the CLI with a fake harness CLI on PATH', () => {
  let env: TempEnv;

  beforeEach(() => {
    env = makeTempEnv();
    fakeCommand(env, { name: 'claude', script: FAKE_CLAUDE });
  });
  afterEach(() => {
    env.cleanup();
  });

  const logLines = (): string[] => readFileSync(path.join(env.bin, 'claude.log'), 'utf8').trimEnd().split('\n');

  it('passes each argument as is, with no shell between (execFile)', async () => {
    // A shell would expand $HOME and split on the & and the space.
    const url = 'https://agentbuffs.com/api/mcp?a=1&b=$HOME x';
    const server = await startFixtureServer({
      document: (origin) => {
        const doc = fixtureDocument({ origin });
        return { ...doc, mcpUrl: url, harnesses: [{ slug: 'claude-code', name: 'Claude Code', detect: { commands: ['claude'] }, mcp: { ...ADD, args: ['mcp', 'add', '--transport', 'http', 'agentbuffs', url] }, skill: null }] };
      },
    });
    try {
      const result = await runCli({ env, argv: ['--client', 'claude-code', '--api', server.origin, '--yes'] });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(logLines(), ['mcp', 'get', 'agentbuffs', '--', 'mcp', 'add', '--transport', 'http', 'agentbuffs', url, '--']);
      assert.match(result.out, /✓ Claude Code +MCP server\n/);
    } finally {
      await server.close();
    }
  });

  it('says already there when `claude mcp get` finds the same URL, and does not add again', async () => {
    const server = await startFixtureServer({ document: (origin) => fixtureDocument({ origin }) });
    try {
      await runCli({ env, argv: ['--client', 'claude-code', '--what', 'mcp', '--api', server.origin, '--yes'] });
      const second = await runCli({ env, argv: ['--client', 'claude-code', '--what', 'mcp', '--api', server.origin, '--yes'] });
      assert.equal(second.code, 0, second.err);
      assert.match(second.out, /• Claude Code +already set up/);
      assert.equal(logLines().filter((line) => line === 'add').length, 1);
    } finally {
      await server.close();
    }
  });

  it("reports the harness CLI's own output when it fails", async () => {
    writeFileSync(path.join(env.bin, 'fail'), '');
    const server = await startFixtureServer({ document: (origin) => fixtureDocument({ origin }) });
    try {
      const result = await runCli({ env, argv: ['--client', 'claude-code', '--what', 'mcp', '--api', server.origin, '--yes'] });
      assert.equal(result.code, 1);
      assert.match(result.out, /✗ Claude Code +MCP: claude failed, exit code 4: boom: config locked/);
    } finally {
      await server.close();
    }
  });

  it('refuses a command outside the allowlist from the server and never runs it', async () => {
    fakeCommand(env, { name: 'bash', script: `#!/bin/sh\ntouch "$(dirname "$0")/bash-ran"\n` });
    const server = await startFixtureServer({
      document: (origin) => ({
        ...fixtureDocument({ origin }),
        harnesses: [{ slug: 'evil', name: 'Evil', detect: { commands: [] }, mcp: { kind: 'run', command: 'bash', args: ['-c', 'id', MCP_URL] }, skill: null }],
      }),
    });
    try {
      const result = await runCli({ env, argv: ['--client', 'evil', '--api', server.origin, '--yes'] });
      assert.equal(result.code, 1);
      assert.match(result.out, /✗ Evil +MCP: the command "bash" is not one this CLI runs/);
      assert.equal(existsSync(path.join(env.bin, 'bash-ran')), false);
    } finally {
      await server.close();
    }
  });

  it('refuses args without the MCP URL and never runs the command', async () => {
    const server = await startFixtureServer({
      document: (origin) => ({
        ...fixtureDocument({ origin }),
        harnesses: [{ slug: 'claude-code', name: 'Claude Code', detect: { commands: ['claude'] }, mcp: { kind: 'run', command: 'claude', args: ['mcp', 'add', 'agentbuffs', 'https://evil.example/mcp'] }, skill: null }],
      }),
    });
    try {
      const result = await runCli({ env, argv: ['--client', 'claude-code', '--api', server.origin, '--yes'] });
      assert.equal(result.code, 1);
      assert.match(result.out, /✗ Claude Code +MCP: the arguments do not contain/);
      assert.equal(existsSync(path.join(env.bin, 'claude.log')), false);
    } finally {
      await server.close();
    }
  });
});
