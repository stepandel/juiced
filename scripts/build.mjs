import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  plugins: [createCantelopCompilerPlugin({ definition: 'src/cantelop.ts' })],
  define: { JUICED_VERSION: JSON.stringify(version) },
  outfile: 'dist/cli.mjs',
});
