/**
 * Which runs get the full screen: only a person at a terminal that can draw
 * it. Pipes, CI, --yes, --no-fullscreen, no colour, TERM=dumb and small
 * terminals keep the linear output, and a linear run never enters the
 * alternate screen.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { makePaint } from '../src/ansi.ts';
import { main, type CliIo } from '../src/main.ts';
import { chooseScreenMode, type ScreenFacts } from '../src/screen-mode.ts';
import { terminalScreen } from '../src/screen.ts';
import { fixtureDocument, makeTempEnv, runCli, startFixtureServer, type FixtureServer, type TempEnv } from './helpers.ts';
import { fakeTerminal } from './terminal-driver.ts';

const TERMINAL: ScreenFacts = {
  argv: [],
  isStdinTty: true,
  isStdoutTty: true,
  colorBits: 24,
  size: { columns: 80, rows: 24 },
  env: { TERM: 'xterm-256color' },
};

describe('chooseScreenMode', () => {
  it('gives a person at a colour terminal the full screen, a --dry-run included', () => {
    assert.equal(chooseScreenMode(TERMINAL), 'fullscreen');
    assert.equal(chooseScreenMode({ ...TERMINAL, argv: ['--dry-run'] }), 'fullscreen');
    assert.equal(chooseScreenMode({ ...TERMINAL, argv: ['--client', 'cursor'] }), 'fullscreen');
  });

  it('keeps plain lines without a terminal on stdout', () => {
    assert.equal(chooseScreenMode({ ...TERMINAL, isStdoutTty: false }), 'plain');
    assert.equal(chooseScreenMode({ ...TERMINAL, isStdoutTty: false, isStdinTty: false, argv: ['--dry-run'] }), 'plain');
  });

  it('keeps the linear look without a keyboard, with --yes, --no-fullscreen, --help or --version', () => {
    assert.equal(chooseScreenMode({ ...TERMINAL, isStdinTty: false }), 'terminal');
    for (const argv of [['--yes'], ['-y'], ['--no-fullscreen'], ['--help'], ['--version'], ['--client', 'cursor', '--yes']]) {
      assert.equal(chooseScreenMode({ ...TERMINAL, argv }), 'terminal', argv.join(' '));
    }
  });

  it('keeps the linear look without colour, on TERM=dumb and on a small terminal', () => {
    assert.equal(chooseScreenMode({ ...TERMINAL, colorBits: 1 }), 'terminal');
    assert.equal(chooseScreenMode({ ...TERMINAL, env: { NO_COLOR: '1' } }), 'terminal');
    assert.equal(chooseScreenMode({ ...TERMINAL, env: { TERM: 'dumb' } }), 'terminal');
    assert.equal(chooseScreenMode({ ...TERMINAL, size: null }), 'terminal');
    assert.equal(chooseScreenMode({ ...TERMINAL, size: { columns: 59, rows: 40 } }), 'terminal');
    assert.equal(chooseScreenMode({ ...TERMINAL, size: { columns: 120, rows: 17 } }), 'terminal');
  });

  it('leaves a bad flag to main, on a linear screen', () => {
    assert.equal(chooseScreenMode({ ...TERMINAL, argv: ['--what', 'everything'] }), 'terminal');
  });
});

describe('linear runs', () => {
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

  it('accept --no-fullscreen and print the same plain lines', async () => {
    const result = await runCli({ env, argv: ['--no-fullscreen', '--dry-run', '--client', 'cursor', '--api', server.origin] });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Plan\n {2}Cursor {3}MCP server\n/);
    assert.match(result.out, /Dry run\. Nothing was written\./);
  });

  it('list --no-fullscreen in the help', async () => {
    const result = await runCli({ env, argv: ['--help'] });
    assert.match(result.out, /--no-fullscreen {4}Print line by line instead of one screen per step/);
  });

  it('shows an example slug for --client and says where the full list is', async () => {
    const result = await runCli({ env, argv: ['--help'] });
    assert.equal(result.code, 0);
    assert.match(result.out, /--client <slugs> {3}Agents to set up, comma separated, for example\n {21}opencode or claude-code,codex\. Without a terminal,\n {21}--dry-run alone lists every agent and its slug\./);
    assert.doesNotMatch(result.out, /comma separated: claude-code,cursor/, 'no list that reads as the whole list');
    for (const line of result.out.split('\n')) assert.ok(line.length <= 72, `help line stays narrow: ${line}`);
  });

  it('never enter the alternate screen or clear it, in a terminal with --yes', async () => {
    const chunks: string[] = [];
    const stdout = fakeTerminal({ columns: 80, rows: 24 }, (text) => chunks.push(text));
    const io: CliIo = {
      argv: ['--client', 'cursor', '--yes', '--api', server.origin],
      out: () => undefined,
      screen: terminalScreen({ stdout, stderr: new PassThrough(), paint: makePaint(24) }),
      isInteractive: true,
      ctx: env.ctx,
      prompter: { chooseHarnesses: () => assert.fail('asked'), chooseWhat: () => assert.fail('asked'), choosePlanAction: () => assert.fail('asked'), confirm: () => assert.fail('asked') },
      exec: () => assert.fail('ran'),
      version: '9.9.9',
    };
    assert.equal(await main(io), 0);
    await new Promise((resolve) => setImmediate(resolve));
    const bytes = chunks.join('');
    assert.doesNotMatch(bytes, /\u001b\[\?1049[hl]/);
    assert.doesNotMatch(bytes, /\u001b\[2J/);
    assert.match(bytes, /✓.*Cursor/);
  });
});
