import { CantelopClient } from '@cantelop/sdk';
import { claudeAuth } from '@cantelop/sdk/harnesses/claude';
import type { TerminalCommand, TerminalEvent, TerminalReply } from './protocol.js';
import { activateTerminal, receiveTerminal } from './runtime/terminal.js';

const cantelop = new CantelopClient();

export const fleet = cantelop.fleet<TerminalCommand, TerminalEvent, TerminalReply>({
  name: 'juiced',
  runtime: { onActivate: activateTerminal, receive: receiveTerminal },
  auth: claudeAuth,
  dockerfile: 'Dockerfile',
  environment: {
    GH_TOKEN: { secret: true },
    CLAUDE_PATH: { default: '/usr/local/bin/claude' },
  },
});
