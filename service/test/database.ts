import { Pool } from 'pg';
import { migrate } from '../src/db.js';
export async function testDatabase() {
  const url = process.env.JUICED_TEST_DATABASE_URL;
  if (!url) throw new Error('JUICED_TEST_DATABASE_URL required');
  const admin = new Pool({ connectionString: url }),
    schema = 'juiced_test_' + crypto.randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 20 });
  await migrate(pool);
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
export async function user(pool: Pool) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","updatedAt") VALUES($1,'Test user',$2,true,now())`,
    [id, `${id}@example.test`],
  );
  return id;
}
