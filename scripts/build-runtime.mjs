import assert from 'node:assert/strict';
import { buildAppArtifacts } from '@cantelop/sdk/build';

const { apps } = await buildAppArtifacts({ definition: 'src/cantelop.ts', outdir: 'dist/cantelop' });
for (const { name, edge } of apps) {
  assert.equal(edge.manifest.fleet_execution_protocol_version, 1,
    `${name} requires the SDK shared Fleet package contract`);
  assert.ok(edge.manifest.optional_bindings.includes('CANTELOP_FLEET_EXECUTION_VERSION'),
    `${name} must declare the Fleet runtime binding`);
}
