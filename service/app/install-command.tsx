'use client';

import { useState, type ReactNode } from 'react';

export function InstallCommand({
  command,
  children,
}: {
  command: string;
  children?: ReactNode;
}) {
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
      <div className="row">
        <code>
          <span className="prompt" aria-hidden="true">
            ${' '}
          </span>
          {command.slice(0, pipe + 1)}
          <span className="nowrap">{command.slice(pipe + 1)}</span>
        </code>
        <button type="button" onClick={copy} aria-label="Copy install command">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {copied ? (
              <path d="m5 12 5 5L20 7" />
            ) : (
              <>
                <rect x="8" y="8" width="12" height="12" rx="2" />
                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
              </>
            )}
          </svg>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}
