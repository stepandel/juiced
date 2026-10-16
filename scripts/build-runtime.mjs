import { buildAppArtifacts } from '@cantelop/sdk/build';

await buildAppArtifacts({ definition: 'src/cantelop.ts', outdir: 'dist/cantelop' });
