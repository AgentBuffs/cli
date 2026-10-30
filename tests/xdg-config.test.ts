/**
 * A file action may name a path below the XDG config folder (`xdgConfigPath`).
 * It applies only while XDG_CONFIG_HOME is an absolute path; the write stays
 * inside the home dir or the project dir; and a document without the field
 * behaves as before.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseSetupDocument } from '../src/setup-document.ts';
import { MCP_URL, SKILL_TEXT, fixtureDocument, makeTempEnv, readText, runCli, snapshotTree, startFixtureServer, writeFile, type TempEnv } from './helpers.ts';

const OPENCODE_VALUE = { type: 'remote', url: MCP_URL };

function opencodeHarness(opts: { withXdg: boolean }): Record<string, unknown> {
  return {
    slug: 'opencode',
    name: 'OpenCode',
    detect: { commands: ['opencode'], paths: ['~/.config/opencode'], ...(opts.withXdg ? { xdgConfigPaths: ['opencode'] } : {}) },
    mcp: {
      kind: 'json-merge',
      path: '~/.config/opencode/opencode.json',
      ...(opts.withXdg ? { xdgConfigPath: 'opencode/opencode.json' } : {}),
      keyPath: ['mcp', 'agentbuffs'],
      value: OPENCODE_VALUE,
    },
    skill: {
      kind: 'file',
      path: '~/.config/opencode/skills/find-agent-tools/SKILL.md',
      ...(opts.withXdg ? { xdgConfigPath: 'opencode/skills/find-agent-tools/SKILL.md' } : {}),
    },
  };
}

function withXdg(env: TempEnv, xdgConfigHome: string | undefined): TempEnv {
  const extra = xdgConfigHome === undefined ? {} : { XDG_CONFIG_HOME: xdgConfigHome };
  return { ...env, ctx: { ...env.ctx, env: { ...env.ctx.env, ...extra } } };
}

describe('XDG config folder for a file action', () => {
  let env: TempEnv;

  beforeEach(() => {
    env = makeTempEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  /** Runs the CLI for OpenCode against a fixture server; `args` default to an install without questions. */
  async function install(opts: { env: TempEnv; withXdg?: boolean; args?: string[] }): ReturnType<typeof runCli> {
    const server = await startFixtureServer({
      document: (origin) => ({ ...fixtureDocument({ origin }), harnesses: [opencodeHarness({ withXdg: opts.withXdg ?? true })] }),
    });
    try {
      return await runCli({ env: opts.env, argv: [...(opts.args ?? ['--client', 'opencode', '--yes']), '--api', server.origin] });
    } finally {
      await server.close();
    }
  }

  const defaultFile = (): string => path.join(env.home, '.config', 'opencode', 'opencode.json');

  describe('parsing', () => {
    const base = (): Record<string, unknown> => ({ ...fixtureDocument({ origin: 'http://x' }), harnesses: [opencodeHarness({ withXdg: true })] });

    it('reads xdgConfigPath and detect.xdgConfigPaths, and defaults them to null and empty', () => {
      const [withField] = parseSetupDocument(base()).harnesses;
      assert.deepEqual(withField?.detect.xdgConfigPaths, ['opencode']);
      assert.ok(withField?.mcp?.kind === 'json-merge');
      assert.equal(withField.mcp.xdgConfigPath, 'opencode/opencode.json');
      const [without] = parseSetupDocument({ ...base(), harnesses: [opencodeHarness({ withXdg: false })] }).harnesses;
      assert.deepEqual(without?.detect.xdgConfigPaths, []);
      assert.ok(without?.mcp?.kind === 'json-merge');
      assert.equal(without.mcp.xdgConfigPath, null);
    });

    for (const bad of ['/etc/x.json', '../x.json', 'a/../x.json', 'a//x.json', '$HOME/x.json', '%APPDATA%/x.json', 'a\\x.json', 'C:/x.json', '.']) {
      it(`refuses the xdgConfigPath ${JSON.stringify(bad)}`, () => {
        const harness = opencodeHarness({ withXdg: true });
        const mcp = harness.mcp as Record<string, unknown>;
        assert.throws(() => parseSetupDocument({ ...base(), harnesses: [{ ...harness, mcp: { ...mcp, xdgConfigPath: bad } }] }), /xdgConfigPath must be a relative path/);
      });
    }

    it('refuses a bad detect.xdgConfigPaths entry', () => {
      const harness = opencodeHarness({ withXdg: true });
      assert.throws(() => parseSetupDocument({ ...base(), harnesses: [{ ...harness, detect: { commands: [], xdgConfigPaths: ['../x'] } }] }), /detect\.xdgConfigPaths\[0\] must be a relative path/);
    });
  });

  it('writes to ~/.config/opencode while XDG_CONFIG_HOME is unset', async () => {
    const result = await install({ env: withXdg(env, undefined) });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(readText(defaultFile())), { mcp: { agentbuffs: OPENCODE_VALUE } });
    assert.equal(readText(path.join(env.home, '.config', 'opencode', 'skills', 'find-agent-tools', 'SKILL.md')), SKILL_TEXT);
  });

  it('writes below XDG_CONFIG_HOME when it is an absolute path in the home folder, and leaves ~/.config alone', async () => {
    const xdg = path.join(env.home, 'dotfiles', 'config');
    writeFile(path.join(xdg, 'opencode', 'opencode.json'), '{\n  "theme": "dark"\n}\n');
    const result = await install({ env: withXdg(env, xdg) });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(readText(path.join(xdg, 'opencode', 'opencode.json'))), { theme: 'dark', mcp: { agentbuffs: OPENCODE_VALUE } });
    assert.equal(readText(path.join(xdg, 'opencode', 'skills', 'find-agent-tools', 'SKILL.md')), SKILL_TEXT);
    assert.equal(existsSync(path.join(env.home, '.config')), false);
    assert.match(result.out, /Backups: ~\/dotfiles\/config\/opencode\/opencode\.json\.bak/);
  });

  it('writes below XDG_CONFIG_HOME when it is a folder in the project', async () => {
    const xdg = path.join(env.project, '.xdg');
    const result = await install({ env: withXdg(env, xdg) });
    assert.equal(result.code, 0, result.err);
    assert.equal(existsSync(path.join(xdg, 'opencode', 'opencode.json')), true);
  });

  for (const [label, value] of [['empty', ''], ['relative', 'xdg/config'], ['relative with dots', '../elsewhere']] as const) {
    it(`ignores an ${label} XDG_CONFIG_HOME and uses ~/.config`, async () => {
      const result = await install({ env: withXdg(env, value) });
      assert.equal(result.code, 0, result.err);
      assert.equal(existsSync(defaultFile()), true);
      assert.equal(existsSync(path.join(env.project, 'xdg')), false);
    });
  }

  it('a document without the field keeps writing to ~/.config, XDG or not (a server that has not changed yet)', async () => {
    const xdg = path.join(env.home, 'xdg');
    const result = await install({ env: withXdg(env, xdg), withXdg: false });
    assert.equal(result.code, 0, result.err);
    assert.equal(existsSync(defaultFile()), true);
    assert.equal(existsSync(xdg), false);
  });

  it('refuses an XDG_CONFIG_HOME outside the home folder and the project, says why, and writes nothing', async () => {
    const outside = path.join(env.root, 'outside');
    mkdirSync(outside);
    const before = snapshotTree(env.root);
    const result = await install({ env: withXdg(env, outside) });
    assert.equal(result.code, 1);
    assert.match(result.out, /✗ OpenCode/);
    assert.match(result.out, /XDG_CONFIG_HOME is .*outside.*so the file would be .*outside your home folder and this project/);
    assert.match(result.out, /Add the entry by hand, or point XDG_CONFIG_HOME into your home folder/);
    assert.deepEqual(snapshotTree(env.root), before);
  });

  it('refuses an XDG_CONFIG_HOME in the home folder that is a symlink to the outside', async () => {
    const outside = path.join(env.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(env.home, 'cfg'));
    const before = snapshotTree(env.root);
    const result = await install({ env: withXdg(env, path.join(env.home, 'cfg')) });
    assert.equal(result.code, 1);
    assert.match(result.out, /outside your home folder and this project/);
    assert.deepEqual(snapshotTree(env.root), before);
    assert.equal(existsSync(path.join(outside, 'opencode')), false);
  });

  it('--dry-run names the XDG file and writes nothing', async () => {
    const xdg = path.join(env.home, 'xdg');
    const before = snapshotTree(env.root);
    const result = await install({ env: withXdg(env, xdg), args: ['--client', 'opencode', '--dry-run'] });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /create ~\/xdg\/opencode\/opencode\.json/);
    assert.deepEqual(snapshotTree(env.root), before);
  });

  describe('detection', () => {
    async function asked(opts: { env: TempEnv }): Promise<string> {
      const server = await startFixtureServer({ document: (origin) => ({ ...fixtureDocument({ origin }), harnesses: [opencodeHarness({ withXdg: true })] }) });
      try {
        const result = await runCli({ env: opts.env, argv: ['--api', server.origin], interactive: true, answers: { plan: ['cancel'] } });
        return result.asked[0] ?? '';
      } finally {
        await server.close();
      }
    }

    it('finds OpenCode by ~/.config/opencode while XDG_CONFIG_HOME is unset', async () => {
      mkdirSync(path.join(env.home, '.config', 'opencode'), { recursive: true });
      assert.match(await asked({ env: withXdg(env, undefined) }), /preselected=opencode /);
    });

    it('finds OpenCode by its folder below XDG_CONFIG_HOME', async () => {
      const xdg = path.join(env.home, 'xdg');
      mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
      assert.match(await asked({ env: withXdg(env, xdg) }), /preselected=opencode /);
    });

    it('does not find OpenCode by a folder below XDG_CONFIG_HOME when the variable is unset', async () => {
      mkdirSync(path.join(env.home, 'xdg', 'opencode'), { recursive: true });
      assert.match(await asked({ env: withXdg(env, undefined) }), /preselected= /);
    });

    it('does not throw for an XDG folder outside the home folder: detection only reads', async () => {
      const outside = path.join(env.root, 'outside');
      mkdirSync(path.join(outside, 'opencode'), { recursive: true });
      assert.match(await asked({ env: withXdg(env, outside) }), /preselected=opencode /);
    });
  });
});
