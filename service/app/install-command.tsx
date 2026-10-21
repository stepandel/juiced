'use client';

import { useState } from 'react';

export function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
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
        {command}
      </code>
      <button type="button" onClick={copy} aria-label="Copy install command">
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
