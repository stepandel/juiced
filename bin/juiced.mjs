#!/usr/bin/env node
try {
  await import('../dist/cli.mjs');
} catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === new URL('../dist/cli.mjs', import.meta.url).href) {
    process.stderr.write('juiced: run npm install and npm run build first.\n');
    process.exitCode = 1;
  } else {
    throw error;
  }
}
