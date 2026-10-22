'use client';

import { useState } from 'react';

// A terminal snippet: `#` lines are comments, `/` lines are typed inside
// Juiced, and every other line is a shell command.
export function Shell({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const lines = children.split('\n');
  const interactive = lines.some((line) => line.startsWith('/'));
  async function copy() {
    try {
      const commands = lines.filter((line) => !line.startsWith('#'));
      await navigator.clipboard.writeText(commands.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the commands stay selectable.
    }
  }
  return (
    <div className="shell">
      <pre>
        <code>
          {lines.map((line, index) =>
            line.startsWith('#') ? (
              <span key={index} className="comment">
                {line}
                {'\n'}
              </span>
            ) : (
              <span key={index}>
                <span className="prompt" aria-hidden="true">
                  {line.startsWith('/') ? '❯ ' : '$ '}
                </span>
                {line}
                {'\n'}
              </span>
            ),
          )}
        </code>
      </pre>
      {!interactive && (
        <button type="button" onClick={copy} aria-label="Copy commands">
          {copied ? 'copied' : 'copy'}
        </button>
      )}
    </div>
  );
}
