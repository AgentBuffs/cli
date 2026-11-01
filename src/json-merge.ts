/**
 * Sets one value in a JSON (or JSONC) config file and keeps everything else
 * byte for byte: `jsonc-parser` edits only the span it changes, so other keys,
 * their order, their indent and any comments stay as they were. Pure.
 *
 * Strict JSON files are checked with `JSON.parse`, so a comment or a trailing
 * comma refuses the file. JSONC tolerance is only for harnesses whose files
 * are JSONC (VS Code, Zed, Kilo Code, any `.jsonc` file).
 */
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import {
  KeyPathConflictError,
  MergeRefusedError,
  deepEqual,
  isDataRecord,
  lookup,
  nestValue,
  pathToRemove,
  withValueAt,
  withoutValueAt,
  type DataRecord,
  type MergeOutcome,
  type RemoveOutcome,
} from './data.ts';
import type { JsonValue } from './setup-document.ts';

const BOM = '﻿';
const INDENT = 2;

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

function parseStrict(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MergeRefusedError(`it is not valid JSON (${reason})`);
  }
}

function parseJsonc(body: string): unknown {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(body, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first) throw new MergeRefusedError(`it is not valid JSON (${printParseErrorCode(first.error)} on line ${lineOf(body, first.offset)})`);
  return parsed;
}

function parseRoot(body: string, isJsonc: boolean): DataRecord {
  const parsed = isJsonc ? parseJsonc(body) : parseStrict(body);
  if (!isDataRecord(parsed)) throw new MergeRefusedError('its top level is not a JSON object');
  return parsed;
}

function freshText(keyPath: readonly string[], value: JsonValue): string {
  return `${JSON.stringify(nestValue(keyPath, value), null, INDENT)}\n`;
}

function findExisting(root: DataRecord, keyPath: readonly string[]): ReturnType<typeof lookup> {
  try {
    return lookup(root, keyPath);
  } catch (error) {
    if (error instanceof KeyPathConflictError) throw new MergeRefusedError(error.message);
    throw error;
  }
}

/**
 * Plans the merge. `text` is the current file, or null when it does not exist.
 * Throws `MergeRefusedError` for a file it must not touch. The new text is
 * parsed back and compared before it is returned, so a wrong edit never ships.
 */
export function mergeJson(opts: { text: string | null; keyPath: readonly string[]; value: JsonValue; isJsonc: boolean }): MergeOutcome {
  if (opts.text === null) return { change: 'create', text: freshText(opts.keyPath, opts.value) };
  const hasBom = opts.text.startsWith(BOM);
  const body = hasBom ? opts.text.slice(1) : opts.text;
  if (body.trim() === '') return { change: 'add', text: freshText(opts.keyPath, opts.value) };

  const root = parseRoot(body, opts.isJsonc);
  const existing = findExisting(root, opts.keyPath);
  if (existing.found && deepEqual(existing.value, opts.value)) return { change: 'none' };

  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(body, [...opts.keyPath], opts.value, { formattingOptions: { insertSpaces: true, tabSize: INDENT, eol } });
  const edited = applyEdits(body, edits);
  const withNewline = edited.endsWith('\n') ? edited : `${edited}${eol}`;

  const expected = withValueAt({ root, keyPath: opts.keyPath, value: opts.value });
  if (!deepEqual(parseRoot(withNewline, opts.isJsonc), expected)) {
    throw new MergeRefusedError('the edit could not be checked, so the file was left alone');
  }
  const text = hasBom ? `${BOM}${withNewline}` : withNewline;
  if (existing.found) return { change: 'replace', text, existing: existing.value };
  return { change: 'add', text };
}

/**
 * Plans the reverse of `mergeJson`: deletes the value at `keyPath` and leaves
 * the rest of the file byte for byte. A parent object that the removal would
 * leave empty goes too, as `mergeJson` creates it. `text` is the current file, or null when it does not exist.
 * Throws `MergeRefusedError` for a file it must not touch.
 */
export function removeJson(opts: { text: string | null; keyPath: readonly string[]; isJsonc: boolean }): RemoveOutcome {
  if (opts.text === null) return { change: 'none' };
  const hasBom = opts.text.startsWith(BOM);
  const body = hasBom ? opts.text.slice(1) : opts.text;
  if (body.trim() === '') return { change: 'none' };

  const root = parseRoot(body, opts.isJsonc);
  if (!findExisting(root, opts.keyPath).found) return { change: 'none' };

  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const cut = pathToRemove({ root, keyPath: opts.keyPath });
  const edits = modify(body, cut, undefined, { formattingOptions: { insertSpaces: true, tabSize: INDENT, eol } });
  const applied = applyEdits(body, edits);
  // A file that held only the entry ends as `{}`, not as the `{` and `}` on two lines the editor leaves.
  const edited = /^\{\s*\}\s*$/.test(applied) ? `{}${applied.endsWith('\n') ? eol : ''}` : applied;

  const expected = withoutValueAt({ root, keyPath: cut });
  if (!deepEqual(parseRoot(edited, opts.isJsonc), expected)) {
    throw new MergeRefusedError('the edit could not be checked, so the file was left alone');
  }
  return { change: 'remove', text: hasBom ? `${BOM}${edited}` : edited };
}
