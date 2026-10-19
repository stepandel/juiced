import { createClient } from '@libsql/client';
import { acquireCheckout } from '../../src/runtime/project-state.js';

const db = createClient({ url: process.argv[2]! });
const lease = await acquireCheckout(db, 'shared', process.argv[3]!, 'session', error => { console.error(error.message); process.exitCode = 1; });
console.log('READY');
process.stdin.resume();
process.stdin.once('end', async () => { await lease.release(); db.close(); });
