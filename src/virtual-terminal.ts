/**
 * A small terminal in memory: a grid of cells, a cursor and the colour state.
 * It understands what clack and the full-screen view write: text, `\r`, `\n`,
 * SGR colour codes, cursor moves (`A B C D G H`), erases (`J K`), and the
 * private modes for the cursor (`?25`) and the alternate screen (`?1049`).
 *
 * Two uses. The full-screen view feeds clack's prompt output into one, so it
 * can draw the prompt as part of a whole screen. The tests feed the CLI's
 * real bytes into one with a fixed size, to see every screen and to count any
 * scroll or wrap. Pure: no streams, no timers.
 */

const ESC = '\u001b';

/** The colour state as SGR parameters, kept in one canonical order so equal looks compare equal. */
type Style = {
  fg: string | null;
  bg: string | null;
  isBold: boolean;
  isDim: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isInverse: boolean;
  isStrike: boolean;
};

const PLAIN_STYLE: Style = { fg: null, bg: null, isBold: false, isDim: false, isItalic: false, isUnderline: false, isInverse: false, isStrike: false };

type Cell = { char: string; sgr: string };

const BLANK: Cell = { char: ' ', sgr: '' };

function styleToSgr(style: Style): string {
  const flags: Array<[boolean, string]> = [
    [style.isBold, '1'],
    [style.isDim, '2'],
    [style.isItalic, '3'],
    [style.isUnderline, '4'],
    [style.isInverse, '7'],
    [style.isStrike, '9'],
  ];
  const codes = flags.flatMap(([isOn, code]) => (isOn ? [code] : []));
  if (style.fg !== null) codes.push(style.fg);
  if (style.bg !== null) codes.push(style.bg);
  return codes.join(';');
}

/** `38;5;n` or `38;2;r;g;b` at `index`, as one parameter string, and how many codes it took. */
function extendedColour(codes: readonly string[], index: number): { value: string; length: number } {
  const mode = codes[index + 1];
  if (mode === '5') return { value: codes.slice(index, index + 3).join(';'), length: 3 };
  if (mode === '2') return { value: codes.slice(index, index + 5).join(';'), length: 5 };
  return { value: codes[index] ?? '', length: 1 };
}

function applySimple(style: Style, code: number): Style {
  if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) return { ...style, fg: String(code) };
  if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) return { ...style, bg: String(code) };
  switch (code) {
    case 0:
      return PLAIN_STYLE;
    case 1:
      return { ...style, isBold: true };
    case 2:
      return { ...style, isDim: true };
    case 3:
      return { ...style, isItalic: true };
    case 4:
      return { ...style, isUnderline: true };
    case 7:
      return { ...style, isInverse: true };
    case 9:
      return { ...style, isStrike: true };
    case 22:
      return { ...style, isBold: false, isDim: false };
    case 23:
      return { ...style, isItalic: false };
    case 24:
      return { ...style, isUnderline: false };
    case 27:
      return { ...style, isInverse: false };
    case 29:
      return { ...style, isStrike: false };
    case 39:
      return { ...style, fg: null };
    case 49:
      return { ...style, bg: null };
    default:
      return style;
  }
}

function applySgr(style: Style, params: string): Style {
  if (params === '') return PLAIN_STYLE;
  const codes = params.split(';');
  let next = style;
  let index = 0;
  while (index < codes.length) {
    const code = Number(codes[index]);
    if (code === 38 || code === 48) {
      const { value, length } = extendedColour(codes, index);
      next = code === 38 ? { ...next, fg: value } : { ...next, bg: value };
      index += length;
      continue;
    }
    next = applySimple(next, code);
    index += 1;
  }
  return next;
}

/** One escape sequence: `ESC [ <params> <final>`, the private marker `?` kept in `params`. */
type Csi = { params: string; final: string; length: number };

/** The CSI sequence that starts at `index` (on the ESC), `cut` when the text ends inside it, or null for anything else. */
function readCsi(text: string, index: number): Csi | 'cut' | null {
  if (index + 1 >= text.length) return 'cut';
  if (text[index + 1] !== '[') return null;
  let end = index + 2;
  while (end < text.length && /[0-9;?]/.test(text[end] ?? '')) end += 1;
  const final = text[end];
  if (final === undefined) return 'cut';
  return { params: text.slice(index + 2, end), final, length: end - index + 1 };
}

function countOf(params: string): number {
  const value = Number.parseInt(params, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** A screen buffer: rows of cells. */
type Buffer = Cell[][];

export type TerminalSize = { columns: number; rows: number };

export class VirtualTerminal {
  columns: number;
  /** Null means the buffer grows as text arrives and never scrolls. */
  rows: number | null;
  /** Lines that left the top of a fixed-size screen. A full-screen view must never cause one. */
  scrolls = 0;
  /** Lines that ran past the right edge and wrapped. */
  wraps = 0;
  /** The scrolls and wraps that happened in the alternate screen, where a full-screen view must cause none. */
  alternateScrolls = 0;
  alternateWraps = 0;
  isCursorHidden = false;
  isAlternate = false;
  /** Every `?1049` and `?25` switch, in order: `alt-on`, `alt-off`, `cursor-hide`, `cursor-show`. */
  readonly modes: string[] = [];
  private cells: Buffer = [];
  private saved: { cells: Buffer; x: number; y: number } | null = null;
  private x = 0;
  private y = 0;
  private style: Style = PLAIN_STYLE;
  /** Set after a character lands in the last column: the next one wraps first. */
  private isWrapPending = false;
  private pending = '';

  /** Strict: an escape it does not know throws (the tests). Otherwise it is skipped (the live screen). */
  private readonly isStrict: boolean;

  constructor(opts: { columns: number; rows: number | null; isStrict: boolean }) {
    this.columns = opts.columns;
    this.rows = opts.rows;
    this.isStrict = opts.isStrict;
  }

  get cursor(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  write(chunk: string): void {
    // A write can end in the middle of an escape; the rest comes with the next one.
    const text = this.pending + chunk;
    this.pending = '';
    let index = 0;
    while (index < text.length) {
      const char = text[index] ?? '';
      if (char === ESC) {
        const csi = readCsi(text, index);
        if (csi === 'cut') {
          this.pending = text.slice(index);
          return;
        }
        if (csi === null && this.isStrict) throw new Error(`Unsupported escape ${JSON.stringify(text.slice(index, index + 6))}`);
        if (csi !== null) this.control(csi);
        index += csi?.length ?? 2;
        continue;
      }
      const codePoint = text.codePointAt(index) ?? 0;
      const glyph = String.fromCodePoint(codePoint);
      this.put(glyph);
      index += glyph.length;
    }
  }

  /** Clears the screen and puts the cursor home. */
  reset(): void {
    this.cells = [];
    this.x = 0;
    this.y = 0;
    this.style = PLAIN_STYLE;
    this.isWrapPending = false;
  }

  /** A new size. Lines are cut or padded, never reflowed; the cursor stays inside. */
  resize(size: { columns: number; rows: number | null }): void {
    this.columns = size.columns;
    this.rows = size.rows;
    this.cells = this.cells.map((row) => row.slice(0, size.columns));
    if (size.rows !== null && this.cells.length > size.rows) this.cells = this.cells.slice(this.cells.length - size.rows);
    this.x = Math.min(this.x, size.columns - 1);
    if (size.rows !== null) this.y = Math.min(this.y, size.rows - 1);
    this.isWrapPending = false;
  }

  /** The lines with their colour codes, trailing blank cells and trailing blank lines cut. */
  lines(): string[] {
    const encoded = this.cells.map(encodeRow);
    while (encoded.length > 0 && encoded.at(-1) === '') encoded.pop();
    return encoded;
  }

  /** The lines as plain text, trailing spaces and trailing blank lines cut. */
  text(): string[] {
    const plain = this.cells.map((row) => row.map((cell) => cell.char).join('').trimEnd());
    while (plain.length > 0 && plain.at(-1) === '') plain.pop();
    return plain;
  }

  private row(y: number): Cell[] {
    while (this.cells.length <= y) this.cells.push([]);
    const row = this.cells[y];
    if (row === undefined) throw new Error(`No row ${y}`);
    return row;
  }

  private lineFeed(): void {
    this.isWrapPending = false;
    if (this.rows !== null && this.y >= this.rows - 1) {
      this.cells.shift();
      this.scrolls += 1;
      if (this.isAlternate) this.alternateScrolls += 1;
      this.y = this.rows - 1;
      return;
    }
    this.y += 1;
  }

  private put(glyph: string): void {
    if (glyph === '\n') {
      // A terminal's output processing turns \n into \r\n.
      this.x = 0;
      this.lineFeed();
      return;
    }
    if (glyph === '\r') {
      this.x = 0;
      this.isWrapPending = false;
      return;
    }
    if (glyph === '\b') {
      this.moveTo({ x: this.x - 1, y: this.y });
      return;
    }
    if (glyph === '\t') {
      this.moveTo({ x: (Math.floor(this.x / 8) + 1) * 8, y: this.y });
      return;
    }
    // Other control characters (the bell) draw nothing.
    if (glyph < ' ' || glyph === '\u007f') return;
    if (this.isWrapPending) {
      this.wraps += 1;
      if (this.isAlternate) this.alternateWraps += 1;
      this.x = 0;
      this.lineFeed();
    }
    const row = this.row(this.y);
    while (row.length < this.x) row.push(BLANK);
    row[this.x] = { char: glyph, sgr: styleToSgr(this.style) };
    if (this.x >= this.columns - 1) {
      this.isWrapPending = true;
      return;
    }
    this.x += 1;
  }

  private moveTo(opts: { x: number; y: number }): void {
    this.isWrapPending = false;
    this.x = Math.max(0, Math.min(opts.x, this.columns - 1));
    const lowest = this.rows === null ? Number.POSITIVE_INFINITY : this.rows - 1;
    this.y = Math.max(0, Math.min(opts.y, lowest));
  }

  private eraseLine(mode: string): void {
    const row = this.row(this.y);
    if (mode === '2') {
      row.length = 0;
      return;
    }
    if (mode === '1') {
      for (let x = 0; x <= this.x && x < row.length; x += 1) row[x] = BLANK;
      return;
    }
    row.length = Math.min(row.length, this.x);
  }

  private eraseDisplay(mode: string): void {
    if (mode === '2' || mode === '3') {
      this.cells = [];
      return;
    }
    this.eraseLine('0');
    this.cells.length = Math.min(this.cells.length, this.y + 1);
  }

  private privateMode(opts: { params: string; isOn: boolean }): void {
    if (opts.params === '?25') {
      this.isCursorHidden = !opts.isOn;
      this.modes.push(opts.isOn ? 'cursor-show' : 'cursor-hide');
      return;
    }
    if (opts.params !== '?1049') return;
    this.modes.push(opts.isOn ? 'alt-on' : 'alt-off');
    if (opts.isOn && !this.isAlternate) {
      this.saved = { cells: this.cells, x: this.x, y: this.y };
      this.cells = [];
      this.isAlternate = true;
      return;
    }
    if (!opts.isOn && this.isAlternate && this.saved !== null) {
      this.cells = this.saved.cells;
      this.moveTo({ x: this.saved.x, y: this.saved.y });
      this.saved = null;
      this.isAlternate = false;
    }
  }

  private control(csi: Csi): void {
    const { params, final } = csi;
    switch (final) {
      case 'm':
        this.style = applySgr(this.style, params);
        return;
      case 'A':
        this.moveTo({ x: this.x, y: this.y - countOf(params) });
        return;
      case 'B':
        this.moveTo({ x: this.x, y: this.y + countOf(params) });
        return;
      case 'C':
        this.moveTo({ x: this.x + countOf(params), y: this.y });
        return;
      case 'D':
        this.moveTo({ x: this.x - countOf(params), y: this.y });
        return;
      case 'G':
        this.moveTo({ x: countOf(params) - 1, y: this.y });
        return;
      case 'H': {
        const [row = '1', column = '1'] = params.split(';');
        this.moveTo({ x: countOf(column) - 1, y: countOf(row) - 1 });
        return;
      }
      case 'J':
        this.eraseDisplay(params);
        return;
      case 'K':
        this.eraseLine(params);
        return;
      case 'h':
      case 'l':
        this.privateMode({ params, isOn: final === 'h' });
        return;
      default:
        if (this.isStrict) throw new Error(`Unsupported escape ESC[${params}${final}`);
    }
  }
}

function encodeRow(row: readonly Cell[]): string {
  let end = row.length;
  while (end > 0 && (row[end - 1]?.char ?? ' ') === ' ' && (row[end - 1]?.sgr ?? '') === '') end -= 1;
  let line = '';
  let current = '';
  for (const cell of row.slice(0, end)) {
    if (cell.sgr !== current) {
      line += `${ESC}[0m${cell.sgr === '' ? '' : `${ESC}[${cell.sgr}m`}`;
      current = cell.sgr;
    }
    line += cell.char;
  }
  return current === '' ? line : `${line}${ESC}[0m`;
}

const SGR_PATTERN = /\u001b\[[0-9;]*m/g;

/** Columns a line takes on screen: its characters without colour codes. */
export function visibleWidth(line: string): number {
  return Array.from(line.replaceAll(SGR_PATTERN, '')).length;
}

/** The line cut to `width` visible columns, colour codes kept, the colour reset at a cut. */
export function cropToWidth(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  let result = '';
  let shown = 0;
  let index = 0;
  while (index < line.length && shown < width) {
    if (line[index] === ESC) {
      const csi = readCsi(line, index);
      const length = csi === null || csi === 'cut' ? 1 : csi.length;
      result += line.slice(index, index + length);
      index += length;
      continue;
    }
    const glyph = String.fromCodePoint(line.codePointAt(index) ?? 0);
    result += glyph;
    shown += 1;
    index += glyph.length;
  }
  return `${result}${ESC}[0m`;
}
