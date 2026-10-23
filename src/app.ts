import { fleet } from './cantelop.js';
import { AccountClient } from './account/client.js';
import { VERSION } from './version.js';

const client = new AccountClient();
export const target = await client.prepare(VERSION, fleet.runtimeId, process.env.JUICED_ACCOUNT, new AbortController().signal);
export const app = fleet.connect(target.connection);
