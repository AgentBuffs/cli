/**
 * The opening banner: the agentbuffs mark (a purple pixel flame with a white
 * four point star, hand down-sampled from brand/source/agentbuffs-mark.svg)
 * beside a pixel wordmark. Each text cell shows two pixels, one above the
 * other, with the half blocks ▀ ▄ █. Pure: the caller decides whether a
 * banner fits the terminal at all.
 */
import { BRAND, sgr, swatchCode, type ColorDepth, type Swatch } from './ansi.ts';

/**
 * The mark, 15 by 16 pixels. o deep outline, m mid purple, l light purple,
 * d slate (the diamond around the star), w star glow, W star core, . empty.
 */
const MARK: readonly string[] = [
  '........o......',
  '.......omo.....',
  '......ommo.....',
  '.....ommmo.oo..',
  '..o..ommmoomo..',
  '.omoommmmmmmmo.',
  '.ommmmmdmmmmmo.',
  'ommmmmdwdmmmmmo',
  'ommmmddWddmlmmo',
  'ommlddwWwddllmo',
  'omldwwWWWwwdlmo',
  'olllddwWwddllmo',
  '.olllddWddlllo.',
  '.olllldwdllllo.',
  '..olllldllllo..',
  '...ooooooooo...',
];

/** A 4 by 8 pixel lowercase font, only the letters of the wordmark. Rows 0 and 1 hold ascenders, row 7 the g's tail. */
const FONT: Readonly<Record<string, readonly string[]>> = {
  a: ['....', '....', '.##.', '...#', '.###', '#..#', '.###', '....'],
  b: ['#...', '#...', '###.', '#..#', '#..#', '#..#', '###.', '....'],
  e: ['....', '....', '.##.', '#..#', '####', '#...', '.###', '....'],
  f: ['..##', '.#..', '###.', '.#..', '.#..', '.#..', '.#..', '....'],
  g: ['....', '....', '.###', '#..#', '#..#', '.###', '...#', '.##.'],
  n: ['....', '....', '###.', '#..#', '#..#', '#..#', '#..#', '....'],
  s: ['....', '....', '.###', '#...', '.##.', '...#', '###.', '....'],
  t: ['.#..', '.#..', '###.', '.#..', '.#..', '.#..', '..##', '....'],
  u: ['....', '....', '#..#', '#..#', '#..#', '#..#', '.###', '....'],
};

/** "agent" takes the terminal's own text colour (readable on light and dark themes), "buffs" the brand purple. */
const WORD_PARTS: readonly { text: string; pixel: string }[] = [
  { text: 'agent', pixel: 'A' },
  { text: 'buffs', pixel: 'B' },
];

const TAGLINE = 'MCP servers and skills for your agent';
const GAP = '   ';

/** What each pixel letter paints with. `null` swatch means the terminal's own foreground colour. */
type Ink = { swatch: Swatch | null; isEmptyInMono: boolean };

const INK: Readonly<Record<string, Ink>> = {
  o: { swatch: BRAND.deep, isEmptyInMono: false },
  m: { swatch: BRAND.mid, isEmptyInMono: false },
  l: { swatch: BRAND.light, isEmptyInMono: false },
  d: { swatch: BRAND.slate, isEmptyInMono: false },
  // Without colour the star shows as a hole in the flame.
  w: { swatch: BRAND.glow, isEmptyInMono: true },
  W: { swatch: BRAND.white, isEmptyInMono: true },
  A: { swatch: null, isEmptyInMono: false },
  B: { swatch: BRAND.light, isEmptyInMono: false },
};

function inkOf(pixel: string): Ink | null {
  return INK[pixel] ?? null;
}

function isLit(ink: Ink | null, depth: ColorDepth): ink is Ink {
  if (ink === null) return false;
  return depth > 1 || !ink.isEmptyInMono;
}

function fg(ink: Ink, depth: ColorDepth): string {
  if (ink.swatch === null) return '';
  return swatchCode({ swatch: ink.swatch, depth, isBackground: false });
}

function bg(ink: Ink, depth: ColorDepth): string {
  if (ink.swatch === null) return '';
  return swatchCode({ swatch: ink.swatch, depth, isBackground: true });
}

/** One text cell from the pixel above and the pixel below. */
function cell(opts: { top: string; bottom: string; depth: ColorDepth }): string {
  const { depth } = opts;
  const top = inkOf(opts.top);
  const bottom = inkOf(opts.bottom);
  const hasTop = isLit(top, depth);
  const hasBottom = isLit(bottom, depth);
  if (hasTop && hasBottom && (depth === 1 || top === bottom)) return sgr([fg(top, depth)], '█');
  if (hasTop && hasBottom) return sgr([fg(top, depth), bg(bottom, depth)], '▀');
  if (hasTop) return sgr([fg(top, depth)], '▀');
  if (hasBottom) return sgr([fg(bottom, depth)], '▄');
  return ' ';
}

/** Pixel rows to text lines, two pixel rows per line. */
function toCells(pixels: readonly string[], depth: ColorDepth): string[] {
  const width = Math.max(...pixels.map((row) => row.length));
  const lines: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    const top = (pixels[y] ?? '').padEnd(width, '.');
    const bottom = (pixels[y + 1] ?? '').padEnd(width, '.');
    lines.push([...top].map((pixel, x) => cell({ top: pixel, bottom: bottom[x] ?? '.', depth })).join(''));
  }
  return lines;
}

/** The wordmark as pixel rows: letters 4 wide with a 1 pixel gap. */
function wordmarkPixels(): string[] {
  const rows: string[] = Array.from({ length: 8 }, () => '');
  const letters = WORD_PARTS.flatMap((part) => [...part.text].map((letter) => ({ letter, pixel: part.pixel })));
  letters.forEach(({ letter, pixel }, index) => {
    const glyph = FONT[letter];
    if (glyph === undefined) throw new Error(`The banner font has no "${letter}"`);
    for (let y = 0; y < rows.length; y += 1) {
      const gap = index === 0 ? '' : '.';
      rows[y] += gap + (glyph[y] ?? '....').replaceAll('#', pixel);
    }
  });
  return rows;
}

const MARK_WIDTH = Math.max(...MARK.map((row) => row.length));
const WORDMARK_WIDTH = Math.max(...wordmarkPixels().map((row) => row.length));

/** Columns the banner needs. A narrower terminal gets no banner. */
export const BANNER_WIDTH = MARK_WIDTH + GAP.length + Math.max(WORDMARK_WIDTH, TAGLINE.length);

/** The banner lines: the mark on the left, the wordmark and a tagline beside it. */
export function bannerLines(opts: { depth: ColorDepth }): string[] {
  const { depth } = opts;
  const mark = toCells(MARK, depth);
  const word = toCells(wordmarkPixels(), depth);
  const tagline = depth > 1 ? sgr(['2'], TAGLINE) : TAGLINE;
  // Wordmark on lines 2 to 5 of the 8, the tagline on line 7, level with the flame's base.
  const right: readonly string[] = ['', ...word, '', tagline, ''];
  return mark.map((line, index) => {
    const beside = right[index] ?? '';
    return beside === '' ? line : `${line}${GAP}${beside}`;
  });
}
