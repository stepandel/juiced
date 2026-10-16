import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  plugins: [createCantelopCompilerPlugin({ definition: 'src/cantelop.ts' })],
  outfile: 'dist/cli.mjs',
});
