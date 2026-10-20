import { object, type ClaudeFrame } from './agent-protocol.js';

/** Metadata needed by menus, independent of the displayed conversation history. */
export function observeAgentMetadata(info: ClaudeFrame, tasks: Map<string, ClaudeFrame>, frame: ClaudeFrame) {
  if (frame.type !== 'system') return;
  if (frame.subtype === 'init') {
    if (Array.isArray(frame.plugins)) info.plugins = frame.plugins;
    if (typeof frame.permissionMode === 'string') info.current_permission_mode = frame.permissionMode;
  }
  if (typeof frame.task_id === 'string') {
    if (frame.subtype === 'task_started') tasks.set(frame.task_id, { ...frame, status: 'running' });
    else if (frame.subtype === 'task_notification') tasks.set(frame.task_id, { ...tasks.get(frame.task_id), ...frame });
    else if (frame.subtype === 'task_progress') tasks.set(frame.task_id, { status: 'running', ...tasks.get(frame.task_id), ...frame });
    else if (frame.subtype === 'task_updated') tasks.set(frame.task_id, { ...tasks.get(frame.task_id), ...object(frame.patch), task_id: frame.task_id });
  }
  if (frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks)) {
    tasks.clear();
    for (const raw of frame.tasks) { const task = object(raw); if (typeof task.task_id === 'string') tasks.set(task.task_id, { ...task, status: 'running' }); }
  }
}
