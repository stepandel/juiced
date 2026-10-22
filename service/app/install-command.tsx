'use client';

import { useRef, useState } from 'react';

export function InstallCommand({ command }: { command: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const code = useRef<HTMLElement>(null);
  // Keep the piped shell together when the command wraps.
  const pipe = command.lastIndexOf(' | ');
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus('copied');
    } catch {
      // Clipboard access can be denied; select the command to copy by hand.
      if (code.current) getSelection()?.selectAllChildren(code.current);
      setStatus('failed');
    }
    setTimeout(() => setStatus('idle'), 1600);
  }
  return (
    <div className="install mono">
      <code ref={code}>
        <span className="prompt" aria-hidden="true">
          ${' '}
        </span>
        {command.slice(0, pipe + 1)}
        <span className="nowrap">{command.slice(pipe + 1)}</span>
      </code>
      <button type="button" onClick={copy} aria-label="Copy install command">
        {status === 'copied' ? 'copied' : 'copy'}
      </button>
      <span className="sr-only" role="status">
        {status === 'copied'
          ? 'Install command copied.'
          : status === 'failed'
            ? 'Copy failed. The command is selected so you can copy it.'
            : ''}
      </span>
    </div>
  );
}
