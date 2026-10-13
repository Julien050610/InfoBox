import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('web/vendor', { recursive: true });
await build({
  entryPoints: ['web/editor/codemirror-entry.js'],
  outfile: 'web/vendor/codemirror-editor.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
});
