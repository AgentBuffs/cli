import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { mergeJson } from '../src/json-merge.ts';
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

const KEY_PATH = ['mcpServers', 'agentbuffs'];
const VALUE = { url: MCP_URL };

describe('mergeJson', () => {
  it('creates the file content with 2-space indent and a trailing newline', () => {
    const outcome = mergeJson({ text: null, keyPath: KEY_PATH, value: VALUE, isJsonc: false });
    assert.equal(outcome.change, 'create');
    assert.equal('text' in outcome ? outcome.text : '', `{\n  "mcpServers": {\n    "agentbuffs": {\n      "url": "${MCP_URL}"\n    }\n  }\n}\n`);
  });

  it('keeps other keys and their order', () => {
    const text = '{\n  "theme": "dark",\n  "mcpServers": {\n    "other": { "command": "x" }\n  },\n  "zz": [1, 2]\n}\n';
    const outcome = mergeJson({ text, keyPath: KEY_PATH, value: VALUE, isJsonc: false });
    assert.equal(outcome.change, 'add');
    const merged: unknown = JSON.parse('text' in outcome ? outcome.text : '');
    assert.deepEqual(merged, { theme: 'dark', mcpServers: { other: { command: 'x' }, agentbuffs: VALUE }, zz: [1, 2] });
    // jsonc-parser may re-indent the sibling it inserts after; lines away from the insert stay as they were.
    assert.ok(('text' in outcome ? outcome.text : '').startsWith('{\n  "theme": "dark",\n  "mcpServers": {\n'));
    assert.ok(('text' in outcome ? outcome.text : '').endsWith('  "zz": [1, 2]\n}\n'));
  });

  it('says none for an identical value, whatever the key order', () => {
    const text = JSON.stringify({ mcpServers: { agentbuffs: { url: MCP_URL } } });
    assert.deepEqual(mergeJson({ text, keyPath: KEY_PATH, value: VALUE, isJsonc: false }), { change: 'none' });
  });

  it('says replace for a different existing value', () => {
    const text = JSON.stringify({ mcpServers: { agentbuffs: { url: 'https://old.example/mcp' } } });
    const outcome = mergeJson({ text, keyPath: KEY_PATH, value: VALUE, isJsonc: false });
    assert.equal(outcome.change, 'replace');
  });

  it('refuses invalid JSON and comments in a strict file', () => {
    assert.throws(() => mergeJson({ text: '{ "a": ', keyPath: KEY_PATH, value: VALUE, isJsonc: false }), /not valid JSON/);
    assert.throws(() => mergeJson({ text: '{\n  // note\n  "a": 1\n}\n', keyPath: KEY_PATH, value: VALUE, isJsonc: false }), /not valid JSON/);
  });

  it('refuses a top level that is not an object, and a key path through a non-object', () => {
    assert.throws(() => mergeJson({ text: '[]', keyPath: KEY_PATH, value: VALUE, isJsonc: false }), /not a JSON object/);
    assert.throws(() => mergeJson({ text: '{"mcpServers": 3}', keyPath: KEY_PATH, value: VALUE, isJsonc: false }), /mcpServers is not an object/);
  });

  it('keeps comments in a JSONC file', () => {
    const text = '{\n  // my servers\n  "servers": {\n    "other": { "url": "https://x" }, // keep\n  },\n}\n';
    const outcome = mergeJson({ text, keyPath: ['servers', 'agentbuffs'], value: VALUE, isJsonc: true });
    assert.equal(outcome.change, 'add');
    const merged = 'text' in outcome ? outcome.text : '';
    assert.match(merged, /\/\/ my servers/);
    assert.match(merged, /\/\/ keep/);
    assert.match(merged, /"agentbuffs"/);
  });
});

describe('json-merge through the CLI on a temp HOME', () => {
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

  const cursorFile = (): string => path.join(env.home, '.cursor', 'mcp.json');
  const cursorArgs = (...extra: string[]): string[] => ['--client', 'cursor', '--api', server.origin, ...extra];

  it('creates the file and its parent folders when missing, with no backup', async () => {
    const result = await runCli({ env, argv: cursorArgs('--yes') });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(readText(cursorFile())), { mcpServers: { agentbuffs: { url: MCP_URL } } });
    assert.ok(readText(cursorFile()).endsWith('}\n'));
    assert.equal(existsSync(`${cursorFile()}.bak`), false);
    assert.match(result.out, /✓ Cursor +MCP server\n/);
    assert.doesNotMatch(result.out, /Backups:/);
    assert.match(result.out, /Restart Cursor, then ask your agent:\n"Find me an MCP server for Postgres\."/);
  });

  it('keeps other keys and writes a .bak of the original', async () => {
    const original = '{\n  "mcpServers": {\n    "github": {\n      "url": "https://api.githubcopilot.com/mcp/"\n    }\n  },\n  "other": true\n}\n';
    writeFile(cursorFile(), original);
    const result = await runCli({ env, argv: cursorArgs('--yes') });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(readText(cursorFile())), {
      mcpServers: { github: { url: 'https://api.githubcopilot.com/mcp/' }, agentbuffs: { url: MCP_URL } },
      other: true,
    });
    assert.equal(readText(`${cursorFile()}.bak`), original);
    assert.match(result.out, /Backups: ~\/\.cursor\/mcp\.json\.bak/);
  });

  it('refuses an unparseable file, leaves it alone and exits 1', async () => {
    const broken = '{ "mcpServers": { "github": ';
    writeFile(cursorFile(), broken);
    const result = await runCli({ env, argv: cursorArgs('--yes') });
    assert.equal(result.code, 1);
    assert.equal(readText(cursorFile()), broken);
    assert.equal(existsSync(`${cursorFile()}.bak`), false);
    assert.match(result.out, /✗ Cursor +MCP: ~\/\.cursor\/mcp\.json was not changed: it is not valid JSON/);
    assert.match(result.out, /Nothing new was installed\./);
  });

  it('is idempotent: a second run says already there and writes nothing', async () => {
    await runCli({ env, argv: cursorArgs('--yes') });
    const first = readText(cursorFile());
    const result = await runCli({ env, argv: cursorArgs('--yes') });
    assert.equal(result.code, 0, result.err);
    assert.equal(readText(cursorFile()), first);
    assert.equal(existsSync(`${cursorFile()}.bak`), false);
    assert.match(result.out, /• Cursor +already set up/);
  });

  it('asks before replacing a different agentbuffs entry, and keeps it on no', async () => {
    const original = JSON.stringify({ mcpServers: { agentbuffs: { url: 'https://old.example/mcp' } } }, null, 2);
    writeFile(cursorFile(), original);
    const result = await runCli({ env, argv: cursorArgs(), interactive: true, answers: { plan: ['install'], confirms: [false] } });
    assert.equal(result.code, 0, result.err);
    assert.match(result.asked[1] ?? '', /Cursor already has a different agentbuffs entry\. Replace it\?/);
    assert.equal(readText(cursorFile()), original);
    assert.match(result.out, /• Cursor +MCP: kept the existing entry in ~\/\.cursor\/mcp\.json/);
  });

  it('replaces a different entry with --yes and says so', async () => {
    writeFile(cursorFile(), JSON.stringify({ mcpServers: { agentbuffs: { url: 'https://old.example/mcp' } } }, null, 2));
    const result = await runCli({ env, argv: cursorArgs('--yes') });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(readText(cursorFile())), { mcpServers: { agentbuffs: { url: MCP_URL } } });
    assert.match(result.out, /replace the agentbuffs entry in ~\/\.cursor\/mcp\.json|✓ Cursor +MCP server/);
    assert.match(result.out, /✓ Cursor +MCP server\n/);
    assert.match(result.out, /Backups: ~\/\.cursor\/mcp\.json\.bak/);
  });

  it('keeps comments in VS Code project JSONC', async () => {
    const vscodeFile = path.join(env.project, '.vscode', 'mcp.json');
    writeFile(vscodeFile, '{\n  // shared with the team\n  "servers": {},\n}\n');
    const result = await runCli({ env, argv: ['--client', 'vscode', '--api', server.origin, '--yes'] });
    assert.equal(result.code, 0, result.err);
    const text = readText(vscodeFile);
    assert.match(text, /\/\/ shared with the team/);
    assert.match(text, /"agentbuffs": \{/);
    assert.match(text, /"type": "http"/);
  });

  it('follows a symlinked config file and keeps the link', async () => {
    const real = path.join(env.home, 'dotfiles', 'cursor-mcp.json');
    writeFile(real, '{}\n');
    mkdirSync(path.dirname(cursorFile()), { recursive: true });
    symlinkSync(real, cursorFile());
    const result = await runCli({ env, argv: cursorArgs('--yes') });
    assert.equal(result.code, 0, result.err);
    assert.ok(lstatSync(cursorFile()).isSymbolicLink());
    assert.deepEqual(JSON.parse(readText(real)), { mcpServers: { agentbuffs: { url: MCP_URL } } });
  });
});
