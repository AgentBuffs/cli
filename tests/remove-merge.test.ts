import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MergeRefusedError, type MergeOutcome, type RemoveOutcome } from '../src/data.ts';
import { mergeJson, removeJson } from '../src/json-merge.ts';
import { mergeToml, removeToml } from '../src/toml-merge.ts';
import { MCP_URL } from './helpers.ts';

const JSON_KEY = ['mcpServers', 'agentbuffs'];
const TOML_KEY = ['mcp_servers', 'agentbuffs'];
const VALUE = { url: MCP_URL };

function textOf(outcome: MergeOutcome | RemoveOutcome): string {
  if (outcome.change === 'none') throw new Error('expected a change');
  return outcome.text;
}

/** Merge the entry in, take it out again, and return the file the user is left with. */
function jsonRoundTrip(original: string | null, isJsonc = false): string {
  const merged = textOf(mergeJson({ text: original, keyPath: JSON_KEY, value: VALUE, isJsonc }));
  return textOf(removeJson({ text: merged, keyPath: JSON_KEY, isJsonc }));
}

function tomlRoundTrip(original: string | null): string {
  const merged = textOf(mergeToml({ text: original, keyPath: TOML_KEY, value: VALUE }));
  return textOf(removeToml({ text: merged, keyPath: TOML_KEY }));
}

describe('removeJson', () => {
  it('gives back the original bytes after a merge: other servers, other keys, their order', () => {
    const original = '{\n  "theme": "dark",\n  "mcpServers": {\n    "other": {\n      "command": "x"\n    }\n  },\n  "zz": [\n    1,\n    2\n  ]\n}\n';
    assert.equal(jsonRoundTrip(original), original);
  });

  it('gives back a file that has other keys but no mcpServers yet', () => {
    const original = '{\n  "theme": "dark"\n}\n';
    assert.equal(jsonRoundTrip(original), original);
  });

  it('keeps comments and trailing commas of a JSONC file', () => {
    const original = '{\n  // my servers\n  "servers": {\n    "other": {\n      "url": "https://example.com" // keep\n    }\n  }\n}\n';
    const merged = textOf(mergeJson({ text: original, keyPath: ['servers', 'agentbuffs'], value: VALUE, isJsonc: true }));
    assert.equal(textOf(removeJson({ text: merged, keyPath: ['servers', 'agentbuffs'], isJsonc: true })), original);
  });

  it('keeps CRLF line ends and a BOM', () => {
    const original = '﻿{\r\n  "theme": "dark"\r\n}\r\n';
    assert.equal(jsonRoundTrip(original), original);
  });

  it('leaves `{}` for a file the merge created, and keeps the file', () => {
    assert.equal(jsonRoundTrip(null), '{}\n');
  });

  it('reports none for a missing file, an empty file and an entry that is not there', () => {
    assert.deepEqual(removeJson({ text: null, keyPath: JSON_KEY, isJsonc: false }), { change: 'none' });
    assert.deepEqual(removeJson({ text: '  \n', keyPath: JSON_KEY, isJsonc: false }), { change: 'none' });
    assert.deepEqual(removeJson({ text: '{"mcpServers":{"other":{}}}', keyPath: JSON_KEY, isJsonc: false }), { change: 'none' });
    assert.deepEqual(removeJson({ text: '{"a":1}', keyPath: JSON_KEY, isJsonc: false }), { change: 'none' });
  });

  it('removes an entry whatever its value, so an edited entry goes too', () => {
    const text = '{\n  "mcpServers": {\n    "agentbuffs": {\n      "url": "https://x",\n      "headers": {}\n    },\n    "other": {}\n  }\n}\n';
    assert.equal(textOf(removeJson({ text, keyPath: JSON_KEY, isJsonc: false })), '{\n  "mcpServers": {\n    "other": {}\n  }\n}\n');
  });

  it('refuses a file that is not valid JSON, and a path that runs through a non-object', () => {
    assert.throws(() => removeJson({ text: '{ nope', keyPath: JSON_KEY, isJsonc: false }), MergeRefusedError);
    assert.throws(() => removeJson({ text: '{"mcpServers": 3}', keyPath: JSON_KEY, isJsonc: false }), MergeRefusedError);
    assert.throws(() => removeJson({ text: '// c\n{"a":1}', keyPath: JSON_KEY, isJsonc: false }), MergeRefusedError);
  });
});

describe('removeToml', () => {
  it('gives back the original bytes after a merge', () => {
    for (const original of ['model = "x"\n', '[a]\nb = 1\n', '[a]\nb = 1\n\n[c]\nd = 2\n', '# note\n[mcp_servers.other]\nurl = "u"\n', '']) {
      assert.equal(tomlRoundTrip(original), original, JSON.stringify(original));
    }
  });

  it('keeps CRLF line ends', () => {
    const original = 'model = "x"\r\n\r\n[a]\r\nb = 1\r\n';
    assert.equal(tomlRoundTrip(original), original);
  });

  it('leaves an empty file for a file the merge created, and keeps the file', () => {
    assert.equal(tomlRoundTrip(null), '');
  });

  it('removes the table with its sub-tables and nothing after it', () => {
    const text = 'a = 1\n\n[mcp_servers.agentbuffs]\nurl = "u"\n\n[mcp_servers.agentbuffs.env]\nK = "v"\n\n[other]\nb = 2\n';
    assert.equal(textOf(removeToml({ text, keyPath: TOML_KEY })), 'a = 1\n\n[other]\nb = 2\n');
  });

  it('reports none for a missing file and an entry that is not there', () => {
    assert.deepEqual(removeToml({ text: null, keyPath: TOML_KEY }), { change: 'none' });
    assert.deepEqual(removeToml({ text: '[mcp_servers.other]\nurl = "u"\n', keyPath: TOML_KEY }), { change: 'none' });
  });

  it('refuses a file that is not valid TOML, and an entry written inline', () => {
    assert.throws(() => removeToml({ text: 'a = = 1', keyPath: TOML_KEY }), MergeRefusedError);
    assert.throws(() => removeToml({ text: '[mcp_servers]\nagentbuffs = { url = "u" }\n', keyPath: TOML_KEY }), /by hand/);
  });
});
