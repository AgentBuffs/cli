/**
 * The full-screen wizard: every screen fits the terminal (no scroll, no
 * wrap, at 80 by 24 and on a small terminal), each step replaces the screen,
 * and every way a run ends leaves the alternate screen once and shows the
 * cursor again, with a summary on the normal screen.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { CANCELLED_NOTHING_WRITTEN, STOPPED_WHILE_INSTALLING } from '../src/fullscreen.ts';
import { main, type CliIo } from '../src/main.ts';
import { clackPrompter } from '../src/prompts.ts';
import { execWithoutShell, type ExecFn } from '../src/run-action.ts';
import { runGuarded, type ProcessEvents } from '../src/session.ts';
import type { TerminalSize } from '../src/virtual-terminal.ts';
import { fakeCommand, fixtureDocument, makeTempEnv, snapshotTree, startFixtureServer, writeFile, type FixtureServer, type TempEnv } from './helpers.ts';
import { KEY, countModes, fullscreenSession, runFullscreen, type React, type Session } from './terminal-driver.ts';

const STANDARD: TerminalSize = { columns: 80, rows: 24 };
const SMALL: TerminalSize = { columns: 60, rows: 18 };

/** clack wraps prompt text at process.stdout.columns, which a test runner's pipe does not have. */
function setWrapWidth(columns: number): void {
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
}

/** The agents Claude Code, Cursor and Codex present on the temp HOME. */
function installThree(env: TempEnv): void {
  fakeCommand(env, { name: 'claude', script: '#!/bin/sh\ncase "$2" in get) exit 1;; esac\nexit 0\n' });
  mkdirSync(path.join(env.home, '.cursor'), { recursive: true });
  writeFile(path.join(env.home, '.codex', 'config.toml'), 'model = "o4"\n');
}

/** Enter on every question: the found agents, both parts, Install. */
const ENTER_ALL: React = (screen) => (/◆ {2}(Install into which agents\?|What should they get\?|Go ahead\?)/.test(screen) ? KEY.enter : null);

/** Opens every page of changes, then cancels. */
const READ_ALL_THEN_CANCEL: React = (screen) => {
  if (/◆ {2}(Install into which agents\?|What should they get\?)/.test(screen)) return KEY.enter;
  if (!/◆ {2}Go ahead\?/.test(screen)) return null;
  // The show option is the second; without it the second is Cancel.
  return `${KEY.down}${KEY.enter}`;
};

function assertFits(session: Session): void {
  assert.equal(session.term.alternateScrolls, 0, 'the full screen never scrolls');
  assert.equal(session.term.alternateWraps, 0, 'no line on the full screen wraps');
}

/** One switch into the alternate screen, one out, the cursor hidden inside and shown at the end. */
function assertLeftOnce(session: Session): void {
  const modes = countModes(session.term);
  assert.equal(modes['alt-on'], 1);
  assert.equal(modes['alt-off'], 1);
  assert.equal(session.term.isAlternate, false);
  assert.equal(session.term.isCursorHidden, false);
  assert.equal(session.term.modes.at(-1), 'cursor-show');
}

function normalScreen(session: Session): string {
  return session.term.text().join('\n');
}

describe('the full-screen wizard', () => {
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
    setWrapWidth(STANDARD.columns);
  });
  afterEach(() => {
    env.cleanup();
  });

  const api = (): string[] => ['--api', server.origin];

  it('draws each step as one screen inside 80 by 24 and leaves a summary on the normal screen', async () => {
    installThree(env);
    const session = await runFullscreen({ env, argv: api(), size: STANDARD, react: ENTER_ALL });
    assert.equal(session.code, 0, session.bytes());
    assertFits(session);
    assertLeftOnce(session);
    const steps = ['Step 1 of 4 · Agents', 'Step 2 of 4 · Parts', 'Step 3 of 4 · Plan', 'Step 4 of 4 · Install'];
    const firstSeen = steps.map((step) => session.screens.findIndex((screen) => screen.includes(step)));
    assert.ok(firstSeen.every((index) => index >= 0), `every step is drawn: ${firstSeen.join(', ')}`);
    assert.deepEqual([...firstSeen].toSorted((a, b) => a - b), firstSeen, 'the steps come in order');
    const plan = session.screens.find((screen) => screen.includes('◆  Go ahead?')) ?? '';
    assert.match(plan, /◇ {2}Agents {2}Claude Code, Cursor and Codex/);
    assert.match(plan, /│ {2}Claude Code {3}MCP server \+ skill/);
    assert.match(plan, /○ Show the changes first/);
    const summary = normalScreen(session);
    assert.match(summary, /┌ {3}agentbuffs 9\.9\.9/);
    assert.match(summary, /✓ Claude Code {3}MCP server \+ skill/);
    assert.match(summary, /Backups: ~\/\.codex\/config\.toml\.bak/);
    assert.match(summary, /└ {2}Restart Claude Code, Cursor and Codex, then ask your agent:/);
    assert.doesNotMatch(summary, /◆/, 'no prompt is left on the normal screen');
  });

  it('pages the changes of every agent inside 80 by 24, then cancels and writes nothing', async () => {
    installThree(env);
    fakeCommand(env, { name: 'code', script: '#!/bin/sh\nexit 0\n' });
    fakeCommand(env, { name: 'goose', script: '#!/bin/sh\nexit 0\n' });
    const before = snapshotTree(env.root);
    const session = await runFullscreen({ env, argv: api(), size: STANDARD, react: READ_ALL_THEN_CANCEL });
    assert.equal(session.code, 0, session.bytes());
    assertFits(session);
    assertLeftOnce(session);
    const pageTitles = new Set(session.screens.flatMap((screen) => /Changes, page \d+ of \d+/.exec(screen)?.[0] ?? []));
    assert.ok(pageTitles.size >= 2, `the changes take more than one page: ${[...pageTitles].join(', ')}`);
    const pages = Number(/of (\d+)/.exec([...pageTitles][0] ?? '')?.[1]);
    assert.equal(pageTitles.size, pages, 'every page is shown');
    assert.deepEqual(snapshotTree(env.root), before);
    assert.match(normalScreen(session), /Nothing was written\./);
  });

  it('fits a 60 by 18 terminal with the one-line header, the agent list paging inside the prompt', async () => {
    setWrapWidth(SMALL.columns);
    installThree(env);
    // Twelve more agents to set up by hand, so the list is longer than the screen.
    const manual = Array.from({ length: 12 }, (_, index) => ({
      slug: `manual-${index}`,
      name: `Manual Agent ${index}`,
      detect: { commands: [], paths: [] },
      mcp: { kind: 'manual', steps: ['Open the settings'], docsUrl: null },
      skill: null,
    }));
    const long = await startFixtureServer({ document: (origin) => ({ ...fixtureDocument({ origin }), harnesses: [...(fixtureDocument({ origin }).harnesses as unknown[]), ...manual] }) });
    const session = await runFullscreen({ env, argv: ['--api', long.origin], size: SMALL, react: ENTER_ALL }).finally(() => long.close());
    assert.equal(session.code, 0, session.bytes());
    assertFits(session);
    assertLeftOnce(session);
    const first = session.screens.find((screen) => screen.includes('Install into which agents?')) ?? '';
    assert.match(first.split('\n')[0] ?? '', /^agentbuffs 9\.9\.9 {3}Step 1 of 4 · Agents$/);
    assert.match(first, /│ {2}\.\.\./, 'the list pages instead of growing');
  });

  it('Ctrl+C in a question leaves the screen and says nothing was written', async () => {
    installThree(env);
    const before = snapshotTree(env.root);
    const session = await runFullscreen({ env, argv: api(), size: STANDARD, react: (screen) => (screen.includes('What should they get?') ? KEY.ctrlC : screen.includes('◆') ? KEY.enter : null) });
    assert.equal(session.code, 130);
    assertLeftOnce(session);
    assert.match(normalScreen(session), new RegExp(CANCELLED_NOTHING_WRITTEN.replaceAll('.', '\\.')));
    assert.deepEqual(snapshotTree(env.root), before);
  });

  it('a network error leaves the screen and names the problem', async () => {
    const session = await runFullscreen({ env, argv: ['--api', 'http://127.0.0.1:9'], size: STANDARD, react: () => null });
    assert.equal(session.code, 1);
    assertLeftOnce(session);
    assert.match(normalScreen(session), /Could not reach http:\/\/127\.0\.0\.1:9/);
  });

  it('a resize draws the screen again for the new size', async () => {
    installThree(env);
    let session: Session | null = null;
    let hasResized = false;
    const react: React = (screen) => {
      if (!screen.includes('◆  Install into which agents?') || session === null) return ENTER_ALL(screen);
      if (hasResized) return KEY.enter;
      hasResized = true;
      const { stdout, term } = session;
      setImmediate(() => {
        term.resize(SMALL);
        Object.assign(stdout, SMALL);
        setWrapWidth(SMALL.columns);
        stdout.emit('resize');
      });
      return null;
    };
    const wired = fullscreenSession({ size: STANDARD, react });
    session = wired;
    const io: CliIo = {
      argv: api(),
      out: () => undefined,
      screen: wired.screen,
      isInteractive: true,
      ctx: env.ctx,
      prompter: clackPrompter({ input: wired.keyboard, output: wired.screen.promptOutput }),
      exec: execWithoutShell,
      version: '9.9.9',
    };
    const code = await main(io);
    assert.equal(code, 0);
    assertFits(wired);
    const resized = wired.screens.find((screen) => screen.startsWith('agentbuffs 9.9.9   Step 1 of 4 · Agents')) ?? '';
    assert.match(resized, /◆ {2}Install into which agents\?/, 'the prompt is drawn again under the one-line header');
  });
});

describe('the guards around a full-screen run', () => {
  let server: FixtureServer;
  let env: TempEnv;

  before(async () => {
    server = await startFixtureServer({ document: (origin) => fixtureDocument({ origin }), delayMs: 150 });
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    env = makeTempEnv();
    setWrapWidth(STANDARD.columns);
  });
  afterEach(() => {
    env.cleanup();
  });

  /** `process` for the guards: signals and exit come from the test. */
  function fakeProcess(): ProcessEvents & { emit: (event: string) => void; listeners: () => number } {
    const emitter = new EventEmitter();
    return {
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
      emit: (event) => emitter.emit(event),
      listeners: () => emitter.eventNames().reduce((sum, name) => sum + emitter.listenerCount(name), 0),
    };
  }

  function guardedRun(opts: { react: React; exec?: ExecFn; argv?: string[] }) {
    const session = fullscreenSession({ size: STANDARD, react: opts.react });
    const events = fakeProcess();
    const exits: number[] = [];
    const io: CliIo = {
      argv: opts.argv ?? ['--api', server.origin],
      out: () => undefined,
      screen: session.screen,
      isInteractive: true,
      ctx: env.ctx,
      prompter: clackPrompter({ input: session.keyboard, output: session.screen.promptOutput }),
      exec: opts.exec ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      version: '9.9.9',
    };
    const done = runGuarded({ fullscreen: session.screen, events, exit: (code) => exits.push(code), run: () => main(io) });
    return { session, events, exits, done };
  }

  it('SIGINT before any question leaves the screen and says nothing was written', async () => {
    const run = guardedRun({ react: () => null });
    await new Promise((resolve) => setTimeout(resolve, 40));
    run.events.emit('SIGINT');
    assert.deepEqual(run.exits, [130]);
    assertLeftOnce(run.session);
    assert.match(normalScreen(run.session), /Cancelled\. Nothing was written\./);
    // A real process exits here; this run waits on its first question for good, which holds nothing open.
  });

  it('SIGTERM during the install leaves the screen and does not claim nothing was written', async () => {
    installThree(env);
    let release: () => void = () => undefined;
    const exec: ExecFn = (call) =>
      call.args[1] === 'get' ? Promise.resolve({ exitCode: 1, stdout: '', stderr: '' }) : new Promise((resolve) => (release = () => resolve({ exitCode: 0, stdout: '', stderr: '' })));
    const run = guardedRun({ react: ENTER_ALL, exec });
    for (let wait = 0; wait < 100 && !run.session.screens.some((screen) => screen.includes('Setting up Claude Code')); wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    run.events.emit('SIGTERM');
    assert.deepEqual(run.exits, [143]);
    assertLeftOnce(run.session);
    for (const line of STOPPED_WHILE_INSTALLING.split('\n')) assert.ok(normalScreen(run.session).includes(line), line);
    assert.doesNotMatch(normalScreen(run.session), /Nothing was written/);
    release();
    await run.done;
  });

  it('an unexpected error still leaves the screen, and the guards are removed', async () => {
    const session = fullscreenSession({ size: STANDARD, react: () => null });
    const events = fakeProcess();
    const failing = runGuarded({
      fullscreen: session.screen,
      events,
      exit: () => assert.fail('no exit'),
      run: async () => {
        session.screen.start('9.9.9');
        throw new Error('boom');
      },
    });
    await assert.rejects(failing, /boom/);
    await new Promise((resolve) => setImmediate(resolve));
    assertLeftOnce(session);
    assert.equal(events.listeners(), 0);
  });

  it('the exit guard restores the terminal when the process ends in the middle', async () => {
    const session = fullscreenSession({ size: STANDARD, react: () => null });
    const events = fakeProcess();
    void runGuarded({ fullscreen: session.screen, events, exit: () => undefined, run: () => new Promise(() => session.screen.start('9.9.9')) });
    await new Promise((resolve) => setImmediate(resolve));
    events.emit('exit');
    await new Promise((resolve) => setImmediate(resolve));
    assertLeftOnce(session);
  });
});
