/**
 * YAML text for a `yaml-merge` action. The CLI does not edit YAML files: it
 * shows this snippet as a manual step, because a safe in-place YAML edit needs
 * a full parser. Pure.
 */
import type { JsonValue } from './setup-document.ts';

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function lines(value: JsonValue, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [`${pad}- ${scalar(item)}`];
      const [first = '', ...rest] = lines(item, indent + 2);
      return [`${pad}- ${first.trimStart()}`, ...rest];
    });
  }
  if (typeof value !== 'object' || value === null) return [`${pad}${scalar(value)}`];
  return Object.entries(value).flatMap(([key, item]) => {
    if (typeof item !== 'object' || item === null) return [`${pad}${yamlKey(key)}: ${scalar(item)}`];
    return [`${pad}${yamlKey(key)}:`, ...lines(item, indent + 2)];
  });
}

/** `keyPath` nested as mappings, `value` below it. */
export function yamlSnippet(keyPath: readonly string[], value: JsonValue): string {
  const head = keyPath.map((key, depth) => `${' '.repeat(depth * 2)}${yamlKey(key)}:`);
  return [...head, ...lines(value, keyPath.length * 2)].join('\n');
}
