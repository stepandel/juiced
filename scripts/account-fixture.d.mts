import type { IncomingMessage, ServerResponse } from 'node:http';
export function accountFixtureEnv(root: string, origin: string): Promise<Record<string, string>>;
export function handleAccountFixture(request: IncomingMessage, response: ServerResponse, edgeToken: string): Promise<boolean>;
