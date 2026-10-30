/**
 * The setup document: the contract between agentbuffs.com and this CLI
 * (`GET /api/discover/v1/setup`, M213 spec 19). A small hand-written validator
 * instead of a schema library keeps the published file small.
 *
 * The spec shows `run`, `json-merge` and `file` in full. The other kinds use
 * these fields, chosen to mirror `json-merge`:
 *
 *  - `toml-merge`: `path`, `keyPath` (the table, for Codex
 *    `["mcp_servers", "agentbuffs"]`) and `value` (a flat object).
 *  - `yaml-merge`: `path`, `keyPath`, `value`. Shown as manual steps.
 *  - `manual`: `steps` (plain text lines) and `docsUrl` (or null).
 *  - Any file action may carry `paths: { darwin?, win32?, linux? }`, which
 *    replaces `path` on that platform. `json-merge` may carry `jsonc: true`.
 *
 * An action with any other `kind` is kept as `unsupported` and shown as manual.
 */

export const SUPPORTED_SETUP_VERSION = 1;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Platform = 'darwin' | 'win32' | 'linux';
export type PlatformPaths = Partial<Record<Platform, string>>;

type FileTarget = { path: string; paths: PlatformPaths };

export type RunAction = { kind: 'run'; command: string; args: string[] };
export type JsonMergeAction = FileTarget & { kind: 'json-merge'; keyPath: string[]; value: JsonValue; jsonc: boolean | null };
export type TomlMergeAction = FileTarget & { kind: 'toml-merge'; keyPath: string[]; value: JsonObject };
export type YamlMergeAction = FileTarget & { kind: 'yaml-merge'; keyPath: string[]; value: JsonValue };
export type FileAction = FileTarget & { kind: 'file' };
export type ManualAction = { kind: 'manual'; steps: string[]; docsUrl: string | null };
export type UnsupportedAction = { kind: 'unsupported'; originalKind: string };

export type Action =
  | RunAction
  | JsonMergeAction
  | TomlMergeAction
  | YamlMergeAction
  | FileAction
  | ManualAction
  | UnsupportedAction;

export type Harness = {
  slug: string;
  name: string;
  detect: { commands: string[]; paths: string[] };
  mcp: Action | null;
  skill: Action | null;
};

export type SkillSource = { name: string; url: string; sha256: string };

export type SetupDocument = {
  setupVersion: typeof SUPPORTED_SETUP_VERSION;
  mcpUrl: string;
  serverName: string;
  skill: SkillSource | null;
  harnesses: Harness[];
};

export class SetupDocumentError extends Error {
  override name = 'SetupDocumentError';
}

/** Thrown for a document from a newer server contract: the user needs a newer CLI. */
export class UnsupportedSetupVersionError extends Error {
  override name = 'UnsupportedSetupVersionError';
}

// =============================================================================
// Primitive readers. Each throws with the JSON path of the bad field.
// =============================================================================

type Raw = Record<string, unknown>;

function fail(where: string, problem: string): never {
  throw new SetupDocumentError(`setup document: ${where} ${problem}`);
}

function isRecord(input: unknown): input is Raw {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function readRecord(input: unknown, where: string): Raw {
  if (!isRecord(input)) fail(where, 'must be an object');
  return input;
}

function readString(input: unknown, where: string): string {
  if (typeof input !== 'string' || input.length === 0) fail(where, 'must be a non-empty string');
  return input;
}

function readStringArray(input: unknown, where: string): string[] {
  if (!Array.isArray(input)) fail(where, 'must be an array of strings');
  return input.map((item, index) => readString(item, `${where}[${index}]`));
}

function readOptionalStringArray(input: unknown, where: string): string[] {
  if (input === undefined) return [];
  return readStringArray(input, where);
}

function readHttpUrl(input: unknown, where: string): string {
  const text = readString(input, where);
  if (!URL.canParse(text)) fail(where, 'must be a URL');
  const { protocol } = new URL(text);
  if (protocol !== 'https:' && protocol !== 'http:') fail(where, 'must be an http or https URL');
  return text;
}

function readJsonValue(input: unknown, where: string): JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) fail(where, 'must be a finite number');
    return input;
  }
  if (Array.isArray(input)) return input.map((item, index) => readJsonValue(item, `${where}[${index}]`));
  if (isRecord(input)) return readJsonObject(input, where);
  return fail(where, 'must be JSON data');
}

function readJsonObject(input: unknown, where: string): JsonObject {
  const record = readRecord(input, where);
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(record)) result[key] = readJsonValue(item, `${where}.${key}`);
  return result;
}

function readKeyPath(input: unknown, where: string): string[] {
  const keyPath = readStringArray(input, where);
  if (keyPath.length === 0) fail(where, 'must name at least one key');
  return keyPath;
}

const PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'linux'];

function readPlatformPaths(input: unknown, where: string): PlatformPaths {
  if (input === undefined || input === null) return {};
  const record = readRecord(input, where);
  const result: PlatformPaths = {};
  for (const platform of PLATFORMS) {
    if (record[platform] === undefined) continue;
    result[platform] = readString(record[platform], `${where}.${platform}`);
  }
  return result;
}

function readFileTarget(raw: Raw, where: string): FileTarget {
  return { path: readString(raw.path, `${where}.path`), paths: readPlatformPaths(raw.paths, `${where}.paths`) };
}

// =============================================================================
// Actions and harnesses
// =============================================================================

function readAction(input: unknown, where: string): Action | null {
  if (input === null || input === undefined) return null;
  const raw = readRecord(input, where);
  const kind = readString(raw.kind, `${where}.kind`);
  switch (kind) {
    case 'run':
      return { kind, command: readString(raw.command, `${where}.command`), args: readStringArray(raw.args, `${where}.args`) };
    case 'json-merge': {
      const jsonc = raw.jsonc === undefined ? null : raw.jsonc;
      if (jsonc !== null && typeof jsonc !== 'boolean') fail(`${where}.jsonc`, 'must be a boolean');
      const value = readJsonValue(raw.value, `${where}.value`);
      return { kind, ...readFileTarget(raw, where), keyPath: readKeyPath(raw.keyPath, `${where}.keyPath`), value, jsonc };
    }
    case 'toml-merge': {
      const value = readJsonObject(raw.value, `${where}.value`);
      return { kind, ...readFileTarget(raw, where), keyPath: readKeyPath(raw.keyPath, `${where}.keyPath`), value };
    }
    case 'yaml-merge': {
      const value = readJsonValue(raw.value, `${where}.value`);
      return { kind, ...readFileTarget(raw, where), keyPath: readKeyPath(raw.keyPath, `${where}.keyPath`), value };
    }
    case 'file':
      return { kind, ...readFileTarget(raw, where) };
    case 'manual': {
      const docsUrl = raw.docsUrl === undefined || raw.docsUrl === null ? null : readHttpUrl(raw.docsUrl, `${where}.docsUrl`);
      return { kind, steps: readOptionalStringArray(raw.steps, `${where}.steps`), docsUrl };
    }
    default:
      return { kind: 'unsupported', originalKind: kind };
  }
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function readHarness(input: unknown, where: string): Harness {
  const raw = readRecord(input, where);
  const slug = readString(raw.slug, `${where}.slug`);
  if (!SLUG_PATTERN.test(slug)) fail(`${where}.slug`, 'must be lower-case letters, digits and dashes');
  const detect = raw.detect === undefined ? {} : readRecord(raw.detect, `${where}.detect`);
  return {
    slug,
    name: readString(raw.name, `${where}.name`),
    detect: {
      commands: readOptionalStringArray(detect.commands, `${where}.detect.commands`),
      paths: readOptionalStringArray(detect.paths, `${where}.detect.paths`),
    },
    mcp: readAction(raw.mcp, `${where}.mcp`),
    skill: readAction(raw.skill, `${where}.skill`),
  };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function readSkillSource(input: unknown, where: string): SkillSource | null {
  if (input === null || input === undefined) return null;
  const raw = readRecord(input, where);
  const sha256 = readString(raw.sha256, `${where}.sha256`).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) fail(`${where}.sha256`, 'must be 64 hex characters');
  return { name: readString(raw.name, `${where}.name`), url: readString(raw.url, `${where}.url`), sha256 };
}

/**
 * Validates a parsed setup document. Throws `UnsupportedSetupVersionError` for
 * any `setupVersion` other than the one this CLI reads, and
 * `SetupDocumentError` for any field of the wrong shape.
 */
export function parseSetupDocument(input: unknown): SetupDocument {
  const raw = readRecord(input, 'the document');
  if (raw.setupVersion !== SUPPORTED_SETUP_VERSION) {
    throw new UnsupportedSetupVersionError(
      `The server sent setup version ${JSON.stringify(raw.setupVersion)}, and this agentbuffs reads version ${SUPPORTED_SETUP_VERSION}. ` +
        'Update agentbuffs: run `npx agentbuffs@latest`.',
    );
  }
  const serverName = readString(raw.serverName, 'serverName');
  if (!SLUG_PATTERN.test(serverName)) fail('serverName', 'must be lower-case letters, digits and dashes');
  if (!Array.isArray(raw.harnesses)) fail('harnesses', 'must be an array');
  const harnesses = raw.harnesses.map((item, index) => readHarness(item, `harnesses[${index}]`));
  const slugs = new Set(harnesses.map((harness) => harness.slug));
  if (slugs.size !== harnesses.length) fail('harnesses', 'has a duplicate slug');
  return {
    setupVersion: SUPPORTED_SETUP_VERSION,
    mcpUrl: readHttpUrl(raw.mcpUrl, 'mcpUrl'),
    serverName,
    skill: readSkillSource(raw.skill, 'skill'),
    harnesses,
  };
}
