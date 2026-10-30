/**
 * The look: the banner, the terminal screen's fallbacks, and the words the
 * plain screen prints. The banner and render functions are pure, so these run
 * without a terminal.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makePaint, type ColorDepth } from '../src/ansi.ts';
import { BANNER_WIDTH, bannerLines } from '../src/banner.ts';
import { wrapText } from '../src/render.ts';
import { terminalScreen } from '../src/screen.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANSI = /\u001b\[[0-9;]*m/g;

function visible(line: string): string {
  return line.replaceAll(ANSI, '');
}

/** A fake terminal of `columns` that collects what is written. */
function fakeTerminal(columns: number): { stream: PassThrough & { columns: number }; text: () => string } {
  const stream = Object.assign(new PassThrough(), { columns });
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return { stream, text: () => chunks.join('') };
}

describe('the banner', () => {
  for (const depth of [1, 4, 8, 24] as const satisfies readonly ColorDepth[]) {
    it(`is 8 lines and at most 72 columns at colour depth ${depth}`, () => {
      const lines = bannerLines({ depth });
      assert.equal(lines.length, 8);
      assert.ok(BANNER_WIDTH <= 72, `BANNER_WIDTH is ${BANNER_WIDTH}`);
      for (const line of lines) assert.ok(visible(line).length <= BANNER_WIDTH, `${visible(line).length} columns: ${visible(line)}`);
      assert.match(lines.map(visible).join('\n'), /MCP servers and skills for your agent/);
    });
  }

  it('uses 24-bit brand purple only when the terminal has it', () => {
    const truecolor = bannerLines({ depth: 24 }).join('\n');
    assert.match(truecolor, /38;2;168;85;247/);
    const sixteen = bannerLines({ depth: 4 }).join('\n');
    assert.doesNotMatch(sixteen, /38;[25];/);
    assert.match(sixteen, /\u001b\[95m/);
  });

  it('has no escape codes without colour, and the star shows as a hole', () => {
    const lines = bannerLines({ depth: 1 });
    assert.doesNotMatch(lines.join('\n'), /\u001b/);
    // The star's core is blank inside the flame, between the diamond's sides.
    assert.match((lines[5] ?? '').slice(0, 15), /▄▄ {3}▄▄/);
  });
});

describe('the terminal screen', () => {
  it('draws the banner when it fits, and leaves it out when the terminal is narrower', () => {
    const wide = fakeTerminal(80);
    terminalScreen({ stdout: wide.stream, stderr: new PassThrough(), paint: makePaint(24) }).start('9.9.9');
    assert.match(visible(wide.text()), /MCP servers and skills for your agent/);
    assert.match(visible(wide.text()), /agentbuffs 9\.9\.9/);

    const narrow = fakeTerminal(BANNER_WIDTH - 1);
    terminalScreen({ stdout: narrow.stream, stderr: new PassThrough(), paint: makePaint(24) }).start('9.9.9');
    assert.doesNotMatch(narrow.text(), /MCP servers and skills/);
    assert.match(visible(narrow.text()), /agentbuffs 9\.9\.9/);
  });
});

describe('wrapText', () => {
  it('wraps at spaces with a hanging indent, and keeps a long URL whole', () => {
    assert.deepEqual(wrapText({ text: '  run claude mcp add --scope user', width: 20, indent: 4 }), ['  run claude mcp add', '    --scope user']);
    const url = 'Docs: https://example.com/a/very/long/path/that/does/not/fit';
    assert.deepEqual(wrapText({ text: url, width: 20, indent: 2 }), [url]);
    assert.deepEqual(wrapText({ text: 'short', width: Number.POSITIVE_INFINITY, indent: 2 }), ['short']);
  });
});

describe('the words', () => {
  it('have no em or en dashes in any source file', () => {
    for (const file of readdirSync(path.join(ROOT, 'src'))) {
      const text = readFileSync(path.join(ROOT, 'src', file), 'utf8');
      assert.doesNotMatch(text, /[–—]/, `${file} has a dash`);
    }
    assert.doesNotMatch(readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /[–—]/, 'README.md has a dash');
  });
});
