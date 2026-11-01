/**
 * Adds or replaces one TOML table (Codex `[mcp_servers.agentbuffs]`) as text:
 * append the table when it is absent, swap that table's lines when it differs.
 * Nothing else in the file is rewritten. `smol-toml` only reads: it rejects an
 * invalid file, compares the existing entry, and checks the result, so an
 * edit that would change any other value is refused instead of written. Pure.
 */
import { parse as parseToml } from 'smol-toml';
import {
  KeyPathConflictError,
  MergeRefusedError,
  deepEqual,
  isDataRecord,
  lookup,
  pathToRemove,
  withValueAt,
  withoutValueAt,
  type DataRecord,
  type MergeOutcome,
  type RemoveOutcome,
} from './data.ts';
import type { JsonObject, JsonValue } from './setup-document.ts';

const BOM = '﻿';

// =============================================================================
// Rendering
// =============================================================================

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: JsonValue, where: string): string {
  if (value === null) throw new MergeRefusedError(`${where} is null, which TOML cannot hold`);
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item, index) => tomlValue(item, `${where}[${index}]`)).join(', ')}]`;
  const pairs = Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item, `${where}.${key}`)}`);
  return pairs.length === 0 ? '{}' : `{ ${pairs.join(', ')} }`;
}

/** The table as TOML lines, ending in a newline. Nested objects become inline tables. */
export function renderTomlTable(opts: { keyPath: readonly string[]; value: JsonObject; eol: string }): string {
  const lines = [`[${opts.keyPath.map(tomlKey).join('.')}]`];
  for (const [key, item] of Object.entries(opts.value)) lines.push(`${tomlKey(key)} = ${tomlValue(item, key)}`);
  return lines.map((line) => `${line}${opts.eol}`).join('');
}

// =============================================================================
// Finding table headers in valid TOML text
// =============================================================================

type Header = { lineStart: number; path: string[]; isArray: boolean };

type ScanState = 'normal' | 'comment' | 'basic' | 'literal' | 'ml-basic' | 'ml-literal';

/** Splits `a."b.c".'d'` into keys. The input comes from a file smol-toml already accepted. */
function parseHeaderKeys(inner: string): string[] {
  const keys: string[] = [];
  let index = 0;
  for (let guard = 0; guard <= inner.length && index < inner.length; guard += 1) {
    while (inner[index] === ' ' || inner[index] === '\t') index += 1;
    const quote = inner[index];
    if (quote === '"' || quote === "'") {
      let end = index + 1;
      while (end < inner.length && inner[end] !== quote) end += quote === '"' && inner[end] === '\\' ? 2 : 1;
      const raw = inner.slice(index, end + 1);
      keys.push(quote === '"' ? (JSON.parse(raw) as string) : raw.slice(1, -1));
      index = end + 1;
    }
    if (quote !== '"' && quote !== "'") {
      let end = index;
      while (end < inner.length && inner[end] !== '.' && inner[end] !== ' ' && inner[end] !== '\t') end += 1;
      keys.push(inner.slice(index, end));
      index = end;
    }
    while (inner[index] === ' ' || inner[index] === '\t') index += 1;
    if (inner[index] === '.') index += 1;
  }
  return keys;
}

/** Reads `[a.b]` or `[[a.b]]` starting at `start`; returns the keys and where the bracket text ends. */
function readHeader(text: string, start: number): { path: string[]; isArray: boolean; end: number } {
  const isArray = text.startsWith('[[', start);
  const open = isArray ? 2 : 1;
  let index = start + open;
  let quote: string | null = null;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === '\\') {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === ']') break;
  }
  return { path: parseHeaderKeys(text.slice(start + open, index)), isArray, end: index + open };
}

/** Every `[table]` and `[[array]]` header, skipping brackets inside strings, comments and values. */
function findHeaders(text: string): Header[] {
  const headers: Header[] = [];
  let state: ScanState = 'normal';
  let depth = 0;
  let lineStart = 0;
  let atLineStart = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (state === 'comment') {
      if (char === '\n') state = 'normal';
      if (char !== '\n') continue;
    }
    if (state === 'basic' || state === 'ml-basic') {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (state === 'basic' && char === '"') state = 'normal';
      if (state === 'ml-basic' && text.startsWith('"""', index)) {
        state = 'normal';
        index += 2;
      }
      continue;
    }
    if (state === 'literal') {
      if (char === "'") state = 'normal';
      continue;
    }
    if (state === 'ml-literal') {
      if (text.startsWith("'''", index)) {
        state = 'normal';
        index += 2;
      }
      continue;
    }
    if (char === '\n') {
      atLineStart = true;
      lineStart = index + 1;
      continue;
    }
    if (atLineStart && (char === ' ' || char === '\t' || char === '\r')) continue;
    if (atLineStart && depth === 0 && char === '[') {
      const header = readHeader(text, index);
      headers.push({ lineStart, path: header.path, isArray: header.isArray });
      index = header.end - 1;
      atLineStart = false;
      continue;
    }
    atLineStart = false;
    if (char === '#') state = 'comment';
    if (char === '"') state = text.startsWith('"""', index) ? 'ml-basic' : 'basic';
    if (char === "'") state = text.startsWith("'''", index) ? 'ml-literal' : 'literal';
    if (state === 'ml-basic' || state === 'ml-literal') index += 2;
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
  }
  return headers;
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((key, index) => path[index] === key);
}

/** The end of a section, leaving trailing blank and comment-only lines to the next section. */
function trimSectionEnd(text: string, opts: { start: number; end: number }): number {
  const lines = text.slice(opts.start, opts.end).split(/(?<=\n)/);
  let keep = lines.length;
  while (keep > 1) {
    const trimmed = (lines[keep - 1] ?? '').trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) break;
    keep -= 1;
  }
  return opts.start + lines.slice(0, keep).join('').length;
}

type Span = { start: number; end: number };

/** The spans of the `keyPath` table and its sub-tables, in file order. */
function tableSpans(text: string, keyPath: readonly string[]): Span[] {
  const headers = findHeaders(text);
  const spans: Span[] = [];
  for (const [index, header] of headers.entries()) {
    if (!startsWithPath(header.path, keyPath)) continue;
    if (header.isArray) throw new MergeRefusedError(`it holds [[${keyPath.join('.')}]] as an array of tables`);
    const next = headers[index + 1]?.lineStart ?? text.length;
    spans.push({ start: header.lineStart, end: trimSectionEnd(text, { start: header.lineStart, end: next }) });
  }
  return spans;
}

// =============================================================================
// The merge
// =============================================================================

function parseRoot(body: string): DataRecord {
  try {
    const parsed: unknown = parseToml(body);
    if (!isDataRecord(parsed)) throw new MergeRefusedError('it is not a TOML table');
    return parsed;
  } catch (error) {
    if (error instanceof MergeRefusedError) throw error;
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new MergeRefusedError(`it is not valid TOML (${reason})`);
  }
}

function findExisting(root: DataRecord, keyPath: readonly string[]): ReturnType<typeof lookup> {
  try {
    return lookup(root, keyPath);
  } catch (error) {
    if (error instanceof KeyPathConflictError) throw new MergeRefusedError(error.message);
    throw error;
  }
}

function appendTable(body: string, table: string, eol: string): string {
  if (body === '') return table;
  if (body.endsWith(`${eol}${eol}`)) return `${body}${table}`;
  if (body.endsWith('\n')) return `${body}${eol}${table}`;
  return `${body}${eol}${eol}${table}`;
}

function replaceTable(opts: { body: string; spans: readonly Span[]; table: string }): string {
  const first = opts.spans[0];
  if (!first) {
    throw new MergeRefusedError('the entry is written inline or with dotted keys, so it must be changed by hand');
  }
  let result = opts.body;
  for (const span of opts.spans.toReversed()) {
    const replacement = span === first ? opts.table : '';
    result = result.slice(0, span.start) + replacement + result.slice(span.end);
  }
  return result;
}

/**
 * Plans the merge. `text` is the current file, or null when it does not exist.
 * Throws `MergeRefusedError` for a file it must not touch.
 */
export function mergeToml(opts: { text: string | null; keyPath: readonly string[]; value: JsonObject }): MergeOutcome {
  const eol = opts.text?.includes('\r\n') ? '\r\n' : '\n';
  const table = renderTomlTable({ keyPath: opts.keyPath, value: opts.value, eol });
  if (opts.text === null) return { change: 'create', text: table };
  const hasBom = opts.text.startsWith(BOM);
  const body = hasBom ? opts.text.slice(1) : opts.text;

  const root = parseRoot(body);
  const existing = findExisting(root, opts.keyPath);
  if (existing.found && deepEqual(existing.value, opts.value)) return { change: 'none' };

  const edited = existing.found
    ? replaceTable({ body, spans: tableSpans(body, opts.keyPath), table })
    : appendTable(body, table, eol);
  const expected = withValueAt({ root, keyPath: opts.keyPath, value: opts.value });
  const check = (() => {
    try {
      return parseRoot(edited);
    } catch {
      return null;
    }
  })();
  if (check === null || !deepEqual(check, expected)) {
    throw new MergeRefusedError(`the ${opts.keyPath.join('.')} entry cannot be added here without changing other settings`);
  }
  const text = hasBom ? `${BOM}${edited}` : edited;
  if (existing.found) return { change: 'replace', text, existing: existing.value };
  return { change: 'add', text };
}

const BLANK_LINES = /^(?:[ \t]*\r?\n)*/;

/**
 * The text without the span and the blank lines after it. `mergeToml` puts a
 * blank line in front of a table it appends; when the span was the end of the
 * file, that line goes too, so install then uninstall gives the original back.
 */
function withoutSpan(opts: { text: string; span: Span; eol: string }): string {
  const { text, span } = opts;
  const before = text.slice(0, span.start);
  const rest = text.slice(span.end);
  const after = rest.slice(BLANK_LINES.exec(rest)?.[0].length ?? 0);
  const gap = `${opts.eol}${opts.eol}`;
  if (after === '' && before.endsWith(gap)) return before.slice(0, -opts.eol.length);
  return `${before}${after}`;
}

/**
 * Plans the reverse of `mergeToml`: cuts the `keyPath` table and its
 * sub-tables out of the text and leaves every other byte. `text` is the
 * current file, or null when it does not exist. Throws `MergeRefusedError` for
 * a file it must not touch.
 */
export function removeToml(opts: { text: string | null; keyPath: readonly string[] }): RemoveOutcome {
  if (opts.text === null) return { change: 'none' };
  const hasBom = opts.text.startsWith(BOM);
  const body = hasBom ? opts.text.slice(1) : opts.text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';

  const root = parseRoot(body);
  if (!findExisting(root, opts.keyPath).found) return { change: 'none' };

  const spans = tableSpans(body, opts.keyPath);
  if (spans.length === 0) throw new MergeRefusedError('the entry is written inline or with dotted keys, so it must be removed by hand');
  let edited = body;
  for (const span of spans.toReversed()) edited = withoutSpan({ text: edited, span, eol });

  const check = (() => {
    try {
      return parseRoot(edited);
    } catch {
      return null;
    }
  })();
  // A header-less parent (`[mcp_servers]` was never written) is gone from the text; an explicit one stays as an empty table.
  const expected = [pathToRemove({ root, keyPath: opts.keyPath }), opts.keyPath].map((keyPath) => withoutValueAt({ root, keyPath }));
  if (check === null || !expected.some((candidate) => deepEqual(check, candidate))) {
    throw new MergeRefusedError(`the ${opts.keyPath.join('.')} entry cannot be removed here without changing other settings`);
  }
  return { change: 'remove', text: hasBom ? `${BOM}${edited}` : edited };
}
