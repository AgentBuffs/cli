// Bundles src/cli.ts and every dependency into one dist/cli.mjs, so the
// published package has no runtime dependencies.
import { build } from 'esbuild';
import { chmodSync, statSync } from 'node:fs';

const outfile = 'dist/cli.mjs';

await build({
  entryPoints: ['src/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  // jsonc-parser's "main" is a UMD build that calls require(), which an ES module cannot.
  mainFields: ['module', 'main'],
  format: 'esm',
  target: 'node20',
  minify: true,
  legalComments: 'eof',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});
chmodSync(outfile, 0o755);
console.log(`${outfile}: ${statSync(outfile).size} bytes`);
