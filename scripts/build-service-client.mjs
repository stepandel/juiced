import { buildBackendClient, CANTELOP_CLI_BUILD_PROTOCOL_VERSION } from '@cantelop/sdk/build';
import { fileURLToPath } from 'node:url';

if (CANTELOP_CLI_BUILD_PROTOCOL_VERSION !== 7) throw new Error('Juiced Fleet definitions require an SDK with build protocol 7');
const root = new URL('..', import.meta.url);
await buildBackendClient({
  definition: fileURLToPath(new URL('src/cantelop.ts', root)),
  outdir: fileURLToPath(new URL('service/.cantelop/client', root)),
});
