import { getMigrations } from 'better-auth/db/migration';
import { writeFile } from 'node:fs/promises';
import { authentication, authOptions, seedClient } from './auth.js';
import { config } from './config.js';
import { database, migrate } from './db.js';

const cfg = config(),
  pool = database(cfg.databaseUrl);
try {
  if (process.argv.includes('--generate-auth')) {
    const plan = await getMigrations(authOptions(pool, cfg, true));
    if (!plan.toBeCreated.length)
      throw new Error('Generate the initial auth migration against an empty database');
    await writeFile(
      new URL('../migrations/0002-auth.sql', import.meta.url),
      await plan.compileMigrations(),
    );
  } else {
    await migrate(pool);
    const auth = authentication(pool, cfg, true);
    await seedClient(auth, pool, cfg);
    process.stdout.write('Juiced service migrations and CLI client are current.\n');
  }
} finally {
  await pool.end();
}
