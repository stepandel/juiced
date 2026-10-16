import { CantelopClient } from '@cantelop/sdk';
import { claudeAuth, claudeDockerfile } from '@cantelop/sdk/harnesses/claude';
import type { TerminalCommand, TerminalEvent, TerminalReply } from './protocol.js';
import { activateTerminal, receiveTerminal } from './runtime/terminal.js';

const cantelop = new CantelopClient();

export const app = cantelop.app<TerminalCommand, TerminalEvent, TerminalReply>({
  name: 'juiced',
  runtime: { onActivate: activateTerminal, receive: receiveTerminal },
  auth: claudeAuth,
  dockerfile: claudeDockerfile,
  environment: {
    CLAUDE_PATH: { default: '/usr/local/bin/claude' },
  },
});
