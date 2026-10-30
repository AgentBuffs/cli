import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { parse as parseToml } from 'smol-toml';
import { mergeToml } from '../src/toml-merge.ts';
import {
  MCP_URL,
  fixtureDocument,
  makeTempEnv,
  readText,
  runCli,
  startFixtureServer,
  writeFile,
  type FixtureServer,
  type TempEnv,
} from './helpers.ts';

const KEY_PATH = ['mcp_servers', 'agentbuffs'];
const VALUE = { url: MCP_URL };
const TABLE = `[mcp_servers.agentbuffs]\nurl = "${MCP_URL}"\n`;

/** smol-toml tables have a null prototype; strict deepEqual compares prototypes. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function textOf(outcome: ReturnType<typeof mergeToml>): string {
  if (outcome.change === 'none') throw new Error('expected a change');
  return outcome.text;
}

describe('mergeToml', () => {
  it('creates a file with just the table', () => {
    assert.deepEqual(mergeToml({ text: null, keyPath: KEY_PATH, value: VALUE }), { change: 'create', text: TABLE });
  });

  it('appends the table and leaves every other byte as it was', () => {
    const original = '# my codex config\nmodel = "o4"   # pinned\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "gh-mcp"]\n';
    const outcome = mergeToml({ text: original, keyPath: KEY_PATH, value: VALUE });
    assert.equal(outcome.change, 'add');
    assert.equal(textOf(outcome), `${original}\n${TABLE}`);
  });

  it('adds a newline when the file has none at the end', () => {
    const outcome = mergeToml({ text: 'model = "o4"', keyPath: KEY_PATH, value: VALUE });
    assert.equal(textOf(outcome), `model = "o4"\n\n${TABLE}`);
  });

  it('says none for the same table, quoted key or not', () => {
    const text = `[mcp_servers."agentbuffs"]\nurl = '${MCP_URL}'\n`;
    assert.deepEqual(mergeToml({ text, keyPath: KEY_PATH, value: VALUE }), { change: 'none' });
  });

  it('replaces only the agentbuffs table and its sub-tables, keeping neighbours and their comments', () => {
    const original = [
      'model = "o4"',
      '',
      '[mcp_servers.agentbuffs]',
      'url = "https://old.example/mcp"',
      '',
      '# the GitHub server',
      '[mcp_servers.github]',
      'command = "npx"',
      '',
      '[mcp_servers.agentbuffs.http_headers]',
      'X-Old = "1"',
      '',
      '[profiles.fast]',
      'model = "o4-mini"',
      '',
    ].join('\n');
    const outcome = mergeToml({ text: original, keyPath: KEY_PATH, value: VALUE });
    assert.equal(outcome.change, 'replace');
    const text = textOf(outcome);
    assert.deepEqual(plain(parseToml(text)), {
      model: 'o4',
      mcp_servers: { agentbuffs: { url: MCP_URL }, github: { command: 'npx' } },
      profiles: { fast: { model: 'o4-mini' } },
    });
    assert.match(text, /# the GitHub server\n\[mcp_servers\.github\]/);
    assert.ok(text.startsWith('model = "o4"\n\n[mcp_servers.agentbuffs]\n'));
  });

  it('is not fooled by a header inside a multi-line string', () => {
    const original = `notes = """\n[mcp_servers.agentbuffs]\nurl = "nope"\n"""\n\n[mcp_servers.agentbuffs]\nurl = "https://old.example/mcp"\n`;
    const outcome = mergeToml({ text: original, keyPath: KEY_PATH, value: VALUE });
    assert.deepEqual(plain(parseToml(textOf(outcome))), { notes: '[mcp_servers.agentbuffs]\nurl = "nope"\n', mcp_servers: { agentbuffs: VALUE } });
  });

  it('refuses invalid TOML', () => {
    assert.throws(() => mergeToml({ text: '[mcp_servers\nurl = ', keyPath: KEY_PATH, value: VALUE }), /not valid TOML/);
  });

  it('refuses an entry written inline, because it cannot change it safely', () => {
    const text = `[mcp_servers]\nagentbuffs = { url = "https://old.example/mcp" }\n`;
    assert.throws(() => mergeToml({ text, keyPath: KEY_PATH, value: VALUE }), /inline or with dotted keys/);
  });

  it('refuses to append under a parent written as an inline table', () => {
    const text = `mcp_servers = { github = { command = "npx" } }\n`;
    assert.throws(() => mergeToml({ text, keyPath: KEY_PATH, value: VALUE }), /cannot be added here/);
  });
});

describe('toml-merge for Codex through the CLI on a temp HOME', () => {
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

  const codexFile = (): string => path.join(env.home, '.codex', 'config.toml');
  const codexArgs = (...extra: string[]): string[] => ['--client', 'codex', '--what', 'mcp', '--api', server.origin, ...extra];

  it('keeps the rest of the file, writes a .bak and is idempotent', async () => {
    const original = '# keep me\nmodel = "o4"\n\n[mcp_servers.github]\ncommand = "npx"\n';
    writeFile(codexFile(), original);

    const first = await runCli({ env, argv: codexArgs('--yes') });
    assert.equal(first.code, 0, first.err);
    assert.equal(readText(codexFile()), `${original}\n${TABLE}`);
    assert.equal(readText(`${codexFile()}.bak`), original);
    assert.match(first.out, /Codex: MCP done: wrote ~\/\.codex\/config\.toml, backup ~\/\.codex\/config\.toml\.bak/);

    const second = await runCli({ env, argv: codexArgs('--yes') });
    assert.equal(second.code, 0, second.err);
    assert.equal(readText(codexFile()), `${original}\n${TABLE}`);
    assert.match(second.out, /Codex: MCP skipped: already there/);
  });

  it('refuses an unparseable file and leaves it alone', async () => {
    const broken = '[mcp_servers.github\ncommand = "npx"\n';
    writeFile(codexFile(), broken);
    const result = await runCli({ env, argv: codexArgs('--yes') });
    assert.equal(result.code, 1);
    assert.equal(readText(codexFile()), broken);
    assert.equal(existsSync(`${codexFile()}.bak`), false);
    assert.match(result.out, /config\.toml was not changed: it is not valid TOML/);
  });

  it('asks before replacing a different table, and replaces it on yes', async () => {
    writeFile(codexFile(), '[mcp_servers.agentbuffs]\nurl = "https://old.example/mcp"\n');
    const result = await runCli({ env, argv: codexArgs(), interactive: true, answers: { confirms: [true, true] } });
    assert.equal(result.code, 0, result.err);
    assert.match(result.asked[1] ?? '', /Codex already has a different agentbuffs entry/);
    assert.equal(readText(codexFile()), TABLE);
  });
});
