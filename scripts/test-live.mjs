import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Uses the installed command, the configured Cantelop app, and a real Claude call.
// Run juiced login first. This intentionally stays out of the offline test suite.
function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile('juiced', ['claude', ...args], { timeout: 180_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`juiced claude ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
      } else resolve(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const version = await run(['--version']);
assert.match(version, /\d+\.\d+\.\d+.*Claude Code/i, 'Expected the remote Claude CLI version');
process.stdout.write(`Remote CLI: ${version}\n`);

const expected = `JUICED_E2E_${randomUUID().replaceAll('-', '')}`;
const answer = await run(['-p'], `Reply with exactly ${expected} and no other text. Do not use tools.\n`);
assert.equal(answer, expected, 'Expected the real Claude response to reach local stdout unchanged');
process.stdout.write('Live prompt passed: piped input → Cantelop → Claude → streamed stdout, exit 0.\n');
