'use client';

import { useState } from 'react';

export function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  // Keep the piped shell together when the command wraps.
  const pipe = command.lastIndexOf(' | ');
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the command stays selectable.
    }
  }
  return (
    <div className="install mono">
      <code>
        <span className="prompt" aria-hidden="true">
          ${' '}
        </span>
        {command.slice(0, pipe + 1)}
        <span className="nowrap">{command.slice(pipe + 1)}</span>
      </code>
      <button type="button" onClick={copy} aria-label="Copy install command">
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
