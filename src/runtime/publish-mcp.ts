import { PUBLISH_TIMEOUT_MS } from '../publish-protocol.js';

/** Self-contained Node program passed to Claude's stdio MCP launcher. Its socket timeout matches the server's. */
const PUBLISH_MCP_SOURCE = String.raw`
import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
const tools = [
  { name: 'publish_commits', description: 'Bring completed remote Git commits back to the attached local Juiced checkout. Use only when the user asks to apply work locally. The local user reviews and approves the publication; dirty, changed-branch or divergent local checkouts are refused. A full commit SHA can be supplied; otherwise remote HEAD is pinned at call time.', inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'Explain the changes being brought back.' }, head: { type: 'string', description: 'Optional full Git commit SHA.' } }, required: ['summary'], additionalProperties: false } },
  { name: 'publish_snapshot', description: 'Bring remote file edits back as uncommitted changes in the attached local Juiced checkout, without requiring a user commit. Includes Git-visible additions, deletions, binaries and executable modes. Uses the last shared snapshot as the baseline and refuses conflicting local edits. The local user reviews and approves. Requires an attached local Juiced client.', inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'Explain the file edits being brought back.' } }, required: ['summary'], additionalProperties: false } },
  { name: 'pull_local_changes', description: 'Send changes from the attached laptop checkout into this remote workspace when the user asks to upload or sync local work. Includes commits and uncommitted files by default; set include_uncommitted=false for commits only. Juiced prepares a pinned snapshot and asks for approval on the laptop. The remote checkout must be clean, its HEAD must be an ancestor of local HEAD, and no other Claude session may use it. Do not run this alongside other tools or background jobs writing to the checkout. Do not run the local juiced sync CLI on the remote host. Wait for this tool to report completed application before using the uploaded files.', inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'Explain why local work is needed remotely.' }, include_uncommitted: { type: 'boolean', default: true } }, required: ['summary'], additionalProperties: false } }
];
let initialized = false, negotiated = false, pending = '', decoder = new StringDecoder('utf8');
const calls = new Map();
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const error = (id, code, message) => send({ id, error: { code, message } });
function handle(request) {
  const { id, method, params = {} } = request;
  if (request.jsonrpc !== '2.0' || typeof method !== 'string') { error(id ?? null, -32600, 'Invalid request'); return; }
  if (method === 'notifications/initialized') { initialized = negotiated; return; }
  if (method === 'notifications/cancelled') { calls.get(params.requestId)?.destroy(); return; }
  if (id === undefined) return;
  if (method === 'initialize') {
    if (negotiated) { error(id, -32600, 'Already initialized'); return; }
    negotiated = true;
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    send({ id, result: { protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'juiced-local', version: '1.1.0' }, instructions: 'Use publish_commits or publish_snapshot for remote-to-laptop transfers; use pull_local_changes for laptop-to-remote uploads. These tools require an attached local Juiced client and local approval. A successful call explicitly reports completed application in the destination checkout. Never claim a pending or failed transfer was applied.' } }); return;
  }
  if (method === 'ping') { send({ id, result: {} }); return; }
  if (!initialized) { error(id, -32000, 'Initialize the MCP session first'); return; }
  if (method === 'tools/list') { send({ id, result: { tools } }); return; }
  if (method !== 'tools/call') { error(id, -32601, 'Method not found'); return; }
  const args = params.arguments ?? {};
  if (!tools.some(tool => tool.name === params.name) || !args || Array.isArray(args) || typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 2000 ||
      Object.keys(args).some(key => key !== 'summary' && (key !== 'head' || params.name !== 'publish_commits') && (key !== 'include_uncommitted' || params.name !== 'pull_local_changes')) ||
      args.include_uncommitted !== undefined && typeof args.include_uncommitted !== 'boolean' ||
      args.head !== undefined && (typeof args.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(args.head))) { error(id, -32602, 'Invalid publication arguments'); return; }
  if (calls.size) { send({ id, result: { isError: true, content: [{ type: 'text', text: 'Another local publication is still pending.' }] } }); return; }
  const socket = connect(process.env.JUICED_PUBLISH_SOCKET);
  calls.set(id, socket);
  let response = '', complete = false;
  const finish = result => {
    if (complete) return;
    complete = true; calls.delete(id); socket.destroy();
    send({ id, result: { isError: !['applied', 'already-applied'].includes(result.status), content: [{ type: 'text', text: JSON.stringify(result) }] } });
  };
  socket.setEncoding('utf8'); socket.setTimeout(${PUBLISH_TIMEOUT_MS + 10_000});
  socket.on('connect', () => socket.write(JSON.stringify({ name: params.name, summary: args.summary, ...(args.head !== undefined ? { head: args.head } : {}), ...(params.name === 'pull_local_changes' ? { includeUncommitted: args.include_uncommitted ?? true } : {}) }) + '\n'));
  socket.on('data', data => {
    response += data;
    if (response.length > 16000) { finish({ status: 'failed', message: 'Invalid bridge response.' }); return; }
    if (response.includes('\n')) { try { finish(JSON.parse(response)); } catch { finish({ status: 'failed', message: 'Invalid bridge response.' }); } }
  });
  socket.on('timeout', () => finish({ status: 'failed', message: 'The local publication timed out. Check the local checkout before retrying.' }));
  socket.on('error', () => finish({ status: 'failed', message: 'The Juiced publication bridge is unavailable.' }));
  socket.on('close', () => finish({ status: 'failed', message: 'The publication connection closed. Check the local checkout before retrying.' }));
}
process.stdin.on('data', bytes => {
  pending += decoder.write(bytes);
  for (let end; (end = pending.indexOf('\n')) !== -1;) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (Buffer.byteLength(line) > 16000) { error(null, -32600, 'Request too large'); continue; }
    try { const request = JSON.parse(line); if (!request || typeof request !== 'object' || Array.isArray(request)) error(null, -32600, 'Invalid request'); else handle(request); }
    catch { error(null, -32700, 'Parse error'); }
  }
  if (Buffer.byteLength(pending) > 16000) process.exit(1);
});
process.stdin.on('end', () => { for (const socket of calls.values()) socket.destroy(); process.exit(0); });
`;

export function publishMcpConfiguration(socket: string): string {
  return JSON.stringify({ mcpServers: { 'juiced-local': { type: 'stdio', command: 'node', args: ['--input-type=module', '-e', PUBLISH_MCP_SOURCE], env: { JUICED_PUBLISH_SOCKET: socket } } } });
}
