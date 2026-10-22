import { authentication, seedClient } from './auth';
import { config } from './config';
import { database, migrate } from './db';

// DATABASE_URL is the Neon owner connection; the app roles cannot run DDL.
const cfg = config(),
  pool = database(process.env.DATABASE_URL ?? cfg.databaseUrl);
try {
  await migrate(pool);
  const auth = authentication(pool, cfg, true);
  await seedClient(auth, pool, cfg);
  process.stdout.write('Juiced service migrations and CLI client are current.\n');
} finally {
  await pool.end();
}
