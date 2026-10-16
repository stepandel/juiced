import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = resolve(process.argv[2] ?? join(root, '../cantelop'));
const temporary = await mkdtemp(join(tmpdir(), 'juiced-reconciliation-'));
try {
  const overlay = join(temporary, 'overlay.json');
  await writeFile(overlay, JSON.stringify({ Replace: {
    [join(platform, 'fire-fuse/dispatcher/juiced_latency_probe_test.go')]: join(root, 'diagnostics/cantelop-reconciliation-probe_test.go'),
  } }));
  // The Go overlay adds diagnostics only for this invocation. No platform file changes.
  const result = spawnSync('go', ['test', '-overlay', overlay, './fire-fuse/dispatcher', '-run', '^TestLatencyProbe', '-v', '-count=1'], { cwd: platform, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
