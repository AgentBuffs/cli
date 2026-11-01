/**
 * Small pure helpers over parsed config data, shared by the JSON and TOML merges.
 */

export type DataRecord = Record<string, unknown>;

export function isDataRecord(input: unknown): input is DataRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/** Structural equality; object key order does not matter. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isDataRecord(left) || !isDataRecord(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

export class KeyPathConflictError extends Error {
  override name = 'KeyPathConflictError';
}

export type Lookup = { found: false } | { found: true; value: unknown };

/** The value at `keyPath`. Throws when a step on the way is not an object. */
export function lookup(root: DataRecord, keyPath: readonly string[]): Lookup {
  let node: unknown = root;
  for (const [index, key] of keyPath.entries()) {
    if (!isDataRecord(node)) {
      throw new KeyPathConflictError(`${keyPath.slice(0, index).join('.')} is not an object`);
    }
    if (!Object.hasOwn(node, key)) return { found: false };
    node = node[key];
  }
  return { found: true, value: node };
}

/** A deep copy of `root` with `value` at `keyPath`, creating objects on the way. */
export function withValueAt(opts: { root: DataRecord; keyPath: readonly string[]; value: unknown }): DataRecord {
  const copy: DataRecord = structuredClone(opts.root);
  let node: DataRecord = copy;
  for (const key of opts.keyPath.slice(0, -1)) {
    const next = node[key];
    if (isDataRecord(next)) {
      node = next;
      continue;
    }
    const created: DataRecord = {};
    node[key] = created;
    node = created;
  }
  const last = opts.keyPath.at(-1);
  if (last === undefined) throw new KeyPathConflictError('the key path is empty');
  node[last] = structuredClone(opts.value);
  return copy;
}

/**
 * The shortest key path whose removal takes `keyPath` away and every parent
 * that would be left empty by it. The top level object stays.
 */
export function pathToRemove(opts: { root: DataRecord; keyPath: readonly string[] }): string[] {
  let cut = [...opts.keyPath];
  for (let depth = opts.keyPath.length - 1; depth >= 1; depth -= 1) {
    const parent = lookup(opts.root, opts.keyPath.slice(0, depth));
    const isOnlyChild = parent.found && isDataRecord(parent.value) && Object.keys(parent.value).length === 1;
    if (!isOnlyChild) break;
    cut = opts.keyPath.slice(0, depth);
  }
  return cut;
}

/** A deep copy of `root` without the value at `keyPath`. The parents stay, even when they end up empty. */
export function withoutValueAt(opts: { root: DataRecord; keyPath: readonly string[] }): DataRecord {
  const copy: DataRecord = structuredClone(opts.root);
  const parent = lookup(copy, opts.keyPath.slice(0, -1));
  const last = opts.keyPath.at(-1);
  if (last === undefined) throw new KeyPathConflictError('the key path is empty');
  if (!parent.found || !isDataRecord(parent.value)) throw new KeyPathConflictError(`${opts.keyPath.slice(0, -1).join('.')} is not an object`);
  delete parent.value[last];
  return copy;
}

/** `{ a: { b: value } }` for `["a", "b"]`. */
export function nestValue(keyPath: readonly string[], value: unknown): DataRecord {
  return withValueAt({ root: {}, keyPath, value });
}

export type MergeOutcome =
  /** The same value is already there. */
  | { change: 'none' }
  /** The file does not exist yet. */
  | { change: 'create'; text: string }
  /** The file exists without the entry. */
  | { change: 'add'; text: string }
  /** The file has a different entry under the same key. */
  | { change: 'replace'; text: string; existing: unknown };

export type RemoveOutcome =
  /** The entry is not in the file, or the file does not exist. */
  | { change: 'none' }
  /** The file holds the entry; `text` is the file without it. */
  | { change: 'remove'; text: string };

/** A file the CLI will not touch: unparseable, or the entry sits where it cannot edit safely. */
export class MergeRefusedError extends Error {
  override name = 'MergeRefusedError';
}
