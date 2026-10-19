import React, { useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import type { ModelOption } from '../agent-protocol.js';
import { plain } from './conversation.js';

export function ModelPicker({ models, current, rows, select, cancel }: { models: ModelOption[]; current: string; rows: number; select(value: string): Promise<void>; cancel(): void }) {
  const selected = useRef(Math.max(0, models.findIndex(model => model.value === current)));
  const pending = useRef(false);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [error, setError] = useState('');
  // Pasting a model name or newline must not confirm a selection.
  usePaste(() => {});
  useInput((input, key) => {
    if (pending.current) return;
    if (key.escape || key.ctrl && ['c', 'd'].includes(input)) { cancel(); return; }
    if (key.upArrow || key.downArrow || key.tab) {
      const step = key.upArrow || key.tab && key.shift ? -1 : 1;
      selected.current = (selected.current + step + models.length) % models.length;
      refresh(); return;
    }
    if (key.return) {
      const model = models[selected.current];
      if (!model) return;
      // Keep rapid arrow + Enter and repeated Enter synchronous across renders.
      pending.current = true; setError(''); refresh();
      void select(model.value).catch(error => { pending.current = false; setError(plain((error as Error).message)); refresh(); });
    }
  });
  const limit = Math.max(1, Math.min(6, rows - 12));
  const start = Math.max(0, selected.current - limit + 1);
  const model = models[selected.current];
  return <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} overflow="hidden">
    <Box height={1} flexShrink={0}><Text bold color="green">Choose model</Text></Box>
    {models.slice(start, start + limit).map((model, index) => <Box key={model.value} height={1} flexShrink={0}>
      <Text inverse={start + index === selected.current} wrap="truncate-end">{start + index === selected.current ? '›' : ' '} {plain(model.displayName).replace(/\s+/g, ' ')}{model.value === current ? ' (current)' : ''}</Text>
    </Box>)}
    {model?.description && <Box maxHeight={2} overflow="hidden"><Text dimColor>{plain(model.description).replace(/\s+/g, ' ')}</Text></Box>}
    {error && <Box height={1} flexShrink={0}><Text color="yellow" wrap="truncate-end">{error}</Text></Box>}
    <Box height={1} flexShrink={0}><Text dimColor wrap="truncate-end">{pending.current ? 'Switching model…' : `${selected.current + 1}/${models.length} · /model <name> also accepts a full model ID`}</Text></Box>
  </Box>;
}
