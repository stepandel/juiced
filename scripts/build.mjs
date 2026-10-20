import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  define: {
    JUICED_DEFAULT_SERVICE_URL: JSON.stringify(process.env.JUICED_DEFAULT_SERVICE_URL ?? ''),
    JUICED_VERSION: JSON.stringify(version),
  },
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  plugins: [createCantelopCompilerPlugin({ definition: 'src/cantelop.ts' })],
  outfile: 'dist/cli.mjs',
});
