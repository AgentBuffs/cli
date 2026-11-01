/**
 * The CLI's only two network calls: the setup document and the skill file.
 */
import { createHash } from 'node:crypto';
import { parseSetupDocument, type SetupDocument, type SkillSource } from './setup-document.ts';

export const DEFAULT_API = 'https://agentbuffs.com';
export const SETUP_PATH = '/api/discover/v1/setup';
const REPORTS_PARAM = 'reports';
const SETUP_TIMEOUT_MS = 5_000;
const SKILL_TIMEOUT_MS = 10_000;
const MAX_SKILL_BYTES = 1_000_000;

export class NetworkError extends Error {
  override name = 'NetworkError';
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'no answer within the time limit';
  if (error instanceof Error && error.cause instanceof Error) return error.cause.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function getResponse(opts: { url: URL; timeoutMs: number; version: string; accept: string }): Promise<Response> {
  try {
    const response = await fetch(opts.url, {
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { accept: opts.accept, 'user-agent': `agentbuffs-cli/${opts.version}` },
      redirect: 'follow',
    });
    if (!response.ok) throw new NetworkError(`${opts.url.href} answered HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof NetworkError) throw error;
    throw new NetworkError(`Could not reach ${opts.url.href}: ${reasonOf(error)}`);
  }
}

/** The setup URL for an `--api` base. Throws for a base that is not http or https. */
export function setupUrl(api: string): URL {
  if (!URL.canParse(api)) throw new NetworkError(`--api ${api} is not a URL`);
  const base = new URL(api);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new NetworkError(`--api ${api} must be http or https`);
  return new URL(SETUP_PATH, base);
}

/**
 * Fetches and validates the setup document, with a 5 second limit.
 * `reportsOff` asks the server for the variant without the rating tools
 * (`?reports=off`); the CLI uses whatever the server answers with.
 */
export async function fetchSetupDocument(opts: { api: string; version: string; reportsOff: boolean }): Promise<SetupDocument> {
  const url = setupUrl(opts.api);
  if (opts.reportsOff) url.searchParams.set(REPORTS_PARAM, 'off');
  const response = await getResponse({ url, timeoutMs: SETUP_TIMEOUT_MS, version: opts.version, accept: 'application/json' });
  const body: unknown = await response.json().catch(() => {
    throw new NetworkError(`${url.href} did not answer with JSON`);
  });
  return parseSetupDocument(body);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Downloads the skill file and checks it against the sha256 in the setup document. */
export async function fetchSkillText(opts: { skill: SkillSource; api: string; version: string }): Promise<string> {
  const url = new URL(opts.skill.url, setupUrl(opts.api));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new NetworkError(`The skill URL ${url.href} is not http or https`);
  const response = await getResponse({ url, timeoutMs: SKILL_TIMEOUT_MS, version: opts.version, accept: 'text/markdown, text/plain' });
  const text = await response.text();
  if (text.length > MAX_SKILL_BYTES) throw new NetworkError(`The skill file at ${url.href} is too large`);
  const actual = sha256Hex(text);
  if (actual !== opts.skill.sha256) {
    throw new NetworkError(`The skill file at ${url.href} does not match its checksum`);
  }
  return text;
}
