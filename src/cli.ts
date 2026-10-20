import { app as claudeApp } from './cantelop.js';
import { updateEnvironment } from './environment.js';
import { configureGitHub, GITHUB_CONFIGURE_HELP } from './github-configure.js';
import { HELP, parseArguments } from './args.js';
import { ensureLogin } from './login.js';
import { runRemoteTerminal } from './remote-terminal.js';
import { useLocalTui } from './agent-protocol.js';
import { RemoteAgent } from './remote-agent.js';
import { runLocalTui } from './tui/app.js';
import { selectProject } from './project.js';
import { discoverRepository } from './git.js';
import { createGitSession, GitWorkspaceClient } from './git-workspace.js';
import { deleteWorkspace } from './delete-workspace.js';
import { inspectWorkspace } from './inspect-workspace.js';
import { syncFiles } from './file-sync.js';
import { prepareAgentSession } from './session-state.js';
import { terminalIdentity, usesTerminalSession } from './terminal-session.js';
import { LocalPublisher } from './local-publish.js';

const controller = new AbortController();
let interrupted = 0;
const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal, index) => {
  const handler = () => {
    interrupted = [130, 143, 129][index]!;
    controller.abort(new Error(`Received ${signal}`));
  };
  process.on(signal, handler);
  return { signal, handler };
});

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === 'help') process.stdout.write(args.argv[0] === 'github-configure' ? GITHUB_CONFIGURE_HELP : HELP);
  else if (args.command === 'version') process.stdout.write('juiced 0.1.0\n');
  else if (args.command === 'env') {
    await updateEnvironment(claudeApp.environment(), args.action, args.name, args.secret, process, controller.signal);
  }
  else if (args.command === 'claude' && args.action === 'github-configure') {
    await configureGitHub(claudeApp.environment(), args.stdin, process, controller.signal);
  }
  else if (args.command === 'claude' && (args.action === 'ls' || args.action === 'peek')) {
    process.exitCode = await inspectWorkspace(claudeApp, process.cwd(), args, controller.signal);
  }
  else if (args.command === 'claude' && args.action === 'delete') {
    const project = await selectProject(process.cwd(), args.workspace);
    await deleteWorkspace(claudeApp, project.workspace, args.yes, controller.signal);
  } else if (args.command === 'claude' && args.action === 'file-sync') {
    const project = await selectProject(process.cwd(), args.workspace);
    await syncFiles(claudeApp.workspace({ slug: project.workspace }), project, args.watch, controller.signal);
  } else if (args.command === 'claude') {
    const project = await selectProject(process.cwd(), args.workspace);
    if (process.stderr.isTTY) process.stderr.write(`Connecting to Cantelop workspace ${project.workspace}…\n`);
    const resolved = await claudeApp.workspace({ slug: project.workspace }).resolve();
    const workspace = claudeApp.workspace({ id: resolved.id });
    const introspection = args.action === 'run' && args.argv.length === 1 &&
      ['--help', '-h', '--version', '-v'].includes(args.argv[0]!);
    const maintenance = args.action === 'sync' || args.action === 'fast-forward';
    if (!introspection && !maintenance) await ensureLogin(workspace.auth(), controller.signal);
    if (args.action === 'login') process.stderr.write(`Ready. Run juiced${args.workspace ? ` --workspace ${args.workspace}` : ''} claude from this directory.\n`);
    else {
      const repository = introspection ? undefined : await discoverRepository(project.localDirectory);
      if (maintenance) {
        if (!repository) throw new Error('Git workspace commands require a local Git repository.');
        const client = new GitWorkspaceClient(workspace, project, repository, controller.signal);
        try {
          if (args.action === 'sync' && args.direction === 'to-workspace') {
            await client.send(args.includeUncommitted);
            process.stderr.write(`Transferred local work to ${project.workspace}.\n`);
          } else {
            const result = args.action === 'fast-forward' ? await client.fastForward() : await client.receive();
            process.stderr.write(args.action === 'fast-forward' ? `Fast-forwarded ${repository.branch} to ${result.head.slice(0, 12)}.\n` : `Imported ${result.head.slice(0, 12)} into ${result.ref}.\n`);
          }
        } finally { await client.close().catch(() => {}); }
      } else {
        const localTui = useLocalTui(args.argv, Boolean(process.stdin.isTTY && process.stdout.isTTY));
        if (args.resume && !localTui) throw new Error('Juiced session recovery requires an interactive terminal.');
        const automaticResume = args.action === 'run' && localTui && !args.resume && usesTerminalSession(args.argv, args.newSession);
        const terminal = automaticResume ? await terminalIdentity() : undefined;
        if (automaticResume && !terminal) process.stderr.write('juiced: Could not identify this terminal session; automatic resume is unavailable.\n');
        const selected = localTui ? await prepareAgentSession(project, {
          ...(args.resume ? { resume: true } : {}), ...(args.session ? { explicit: args.session } : {}),
          // Reattaching keeps the saved launch configuration. New Claude
          // arguments must start a new session so prompts and flags take effect.
          ...(args.action === 'run' && (args.newSession || terminal && args.argv.length > 0) ? { fresh: true } : {}),
          ...(terminal ? { terminal: { identity: terminal, workspaceId: resolved.id } } : {}),
        }) : undefined;
        if (repository && !selected?.resumed) {
          if (process.stderr.isTTY) process.stderr.write(`Preparing Git workspace ${project.remoteDirectory}…\n`);
          const client = new GitWorkspaceClient(workspace, project, repository, controller.signal);
          try { await client.send(false, true); } finally { await client.close().catch(() => {}); }
        }
        await selected?.save();
        const id = selected?.id;
        if (terminal && selected?.resumed) process.stderr.write(`Reconnecting to Juiced session ${id}. Use juiced claude --new to start fresh.\n`);
        const session = repository ? createGitSession(workspace, project, id) : workspace.session({ keepAliveSeconds: 120, ...(id ? { id } : {}) });
        const directoryName = introspection ? undefined : project.directoryName;
        const git = repository ? { binding: repository.binding, relativeDirectory: repository.relativeDirectory } : undefined;
        const publisher = repository && localTui ? new LocalPublisher(workspace, project, repository) : undefined;
        process.exitCode = localTui
          ? await runLocalTui(new RemoteAgent(session, { ...(directoryName ? { directoryName } : {}), ...(git ? { git } : {}), ...(publisher && repository ? { localPublish: { head: repository.head, apply: (publication, signal) => publisher.apply(publication, signal) } } : {}) }), args.argv, project.workspace, process, controller.signal)
          : await runRemoteTerminal(session, args.argv, process, { ...(directoryName ? { directoryName } : {}), ...(git ? { git } : {}), signal: controller.signal, term: process.env.TERM ?? 'xterm-256color' });
      }
    }
  }
} catch (error) {
  const code = (error as { code?: string }).code;
  if (process.env.JUICED_DEBUG) {
    const detail = error as Error & { code?: string; status?: number; cause?: Error & { code?: string } };
    process.stderr.write(JSON.stringify({ name: detail.name, message: detail.message, code: detail.code, status: detail.status,
      stack: detail.stack, cause: detail.cause ? { name: detail.cause.name, message: detail.cause.message, code: detail.cause.code } : undefined }) + '\n');
  }
  if (!interrupted) {
    if (code === 'app_configuration_missing' || code === 'app_configuration_invalid' || code === 'app_not_configured') {
      process.stderr.write('juiced: Cantelop app credentials are missing or invalid. Configure the SDK integration profile or set CANTELOP_APP_SLUG, CANTELOP_INTEGRATION_TOKEN, and optionally CANTELOP_EDGE_URL. See README.md for deployment setup.\n');
    } else if (code === 'session_runtime_mismatch') {
      process.stderr.write('juiced: the CLI and deployed runtime differ. Run npm run build and cantelop deploy from the same source.\n');
    } else process.stderr.write(`juiced: ${error instanceof Error ? error.message : 'Unable to start Claude'}\n`);
  }
  process.exitCode = interrupted || (code === 'inspection_incomplete' ? 2 : 1);
} finally {
  for (const { signal, handler } of handlers) process.off(signal, handler);
}
