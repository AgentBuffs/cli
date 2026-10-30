/**
 * Terminal colour, kept to what the CLI uses. A `Paint` with colour off
 * returns the text as it is, so the same render code serves a pipe, a
 * NO_COLOR terminal and a 24-bit terminal. Pure.
 */

/** Colours the terminal can show: 1 (none), 4 (16), 8 (256) or 24 bits. */
export type ColorDepth = 1 | 4 | 8 | 24;

export type Rgb = readonly [number, number, number];

/** One colour in each depth: 24-bit, the nearest of the 256, and the nearest of the 16 (a foreground SGR code). */
export type Swatch = { rgb: Rgb; ansi256: number; ansi16: number };

/** The brand purples from agentbuffs/brand. */
export const BRAND = {
  light: { rgb: [0xa8, 0x55, 0xf7], ansi256: 135, ansi16: 95 },
  mid: { rgb: [0x93, 0x33, 0xea], ansi256: 92, ansi16: 95 },
  deep: { rgb: [0x4c, 0x1d, 0x95], ansi256: 54, ansi16: 35 },
  slate: { rgb: [0x46, 0x3a, 0x5c], ansi256: 60, ansi16: 90 },
  glow: { rgb: [0xdd, 0xd6, 0xfe], ansi256: 189, ansi16: 97 },
  white: { rgb: [0xff, 0xff, 0xff], ansi256: 231, ansi16: 97 },
} as const satisfies Record<string, Swatch>;

const ESC = '\u001b[';
const RESET = `${ESC}0m`;

/** The SGR parameters that set `swatch` as the foreground, or as the background with `isBackground`. */
export function swatchCode(opts: { swatch: Swatch; depth: ColorDepth; isBackground: boolean }): string {
  const { swatch, depth, isBackground } = opts;
  switch (depth) {
    case 24:
      return `${isBackground ? 48 : 38};2;${swatch.rgb.join(';')}`;
    case 8:
      return `${isBackground ? 48 : 38};5;${swatch.ansi256}`;
    case 4:
      return String(isBackground ? swatch.ansi16 + 10 : swatch.ansi16);
    case 1:
      return '';
  }
}

/** Wraps `text` in SGR codes. Empty codes give the text unchanged. */
export function sgr(codes: readonly string[], text: string): string {
  const used = codes.filter((code) => code !== '');
  if (used.length === 0 || text === '') return text;
  return `${ESC}${used.join(';')}m${text}${RESET}`;
}

export type Paint = {
  depth: ColorDepth;
  bold: (text: string) => string;
  dim: (text: string) => string;
  gray: (text: string) => string;
  green: (text: string) => string;
  red: (text: string) => string;
  yellow: (text: string) => string;
  purple: (text: string) => string;
  /** White text on the brand purple, for the intro badge. */
  badge: (text: string) => string;
};

/** A paint for `depth`. Depth 1 is plain text. */
export function makePaint(depth: ColorDepth): Paint {
  const isOn = depth > 1;
  const style = (code: string) => (text: string) => (isOn ? sgr([code], text) : text);
  return {
    depth,
    bold: style('1'),
    dim: style('2'),
    gray: style('90'),
    green: style('32'),
    red: style('31'),
    yellow: style('33'),
    purple: (text) => sgr([swatchCode({ swatch: BRAND.light, depth, isBackground: false })], text),
    badge: (text) =>
      sgr([swatchCode({ swatch: BRAND.white, depth, isBackground: false }), swatchCode({ swatch: BRAND.mid, depth, isBackground: true }), isOn ? '1' : ''], text),
  };
}

/** Plain text, for pipes and tests. */
export const PLAIN: Paint = makePaint(1);

/** Maps Node's `getColorDepth()` (1, 4, 8 or 24) to a `ColorDepth`. */
export function toColorDepth(bits: number): ColorDepth {
  if (bits >= 24) return 24;
  if (bits >= 8) return 8;
  if (bits >= 4) return 4;
  return 1;
}
