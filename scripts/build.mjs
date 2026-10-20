import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';

await build({
  define: {
    JUICED_DEFAULT_SERVICE_URL: JSON.stringify(process.env.JUICED_DEFAULT_SERVICE_URL ?? ''),
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
