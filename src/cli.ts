import { app } from './cantelop.js';
import { HELP, parseArguments } from './args.js';
import { ensureLogin } from './login.js';
import { runRemoteTerminal } from './remote-terminal.js';
import { useLocalTui } from './agent-protocol.js';
import { RemoteAgent } from './remote-agent.js';
import { runLocalTui } from './tui/app.js';
import { selectProject, synchronizeProject, syncError } from './project.js';

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
  if (args.command === 'help') process.stdout.write(HELP);
  else if (args.command === 'version') process.stdout.write('juiced 0.1.0\n');
  else {
    const project = await selectProject(process.cwd(), args.workspace);
    const workspace = app.workspace({ slug: project.workspace });
    if (process.stderr.isTTY) process.stderr.write(`Connecting to Cantelop workspace ${project.workspace}…\n`);
    const introspection = args.command === 'claude' && args.argv.length === 1 &&
      ['--help', '-h', '--version', '-v'].includes(args.argv[0]!);
    if (!introspection) await ensureLogin(workspace.auth(), controller.signal);
    if (args.command === 'login') process.stderr.write(`Ready. Run juiced${args.workspace ? ` --workspace ${args.workspace}` : ''} claude from this directory.\n`);
    else {
      if (!introspection && process.stderr.isTTY) process.stderr.write(`Syncing project to ${project.remoteDirectory}…\n`);
      const sync = introspection ? undefined : await synchronizeProject(workspace, project, controller.signal);
      let syncFailure: Error | undefined;
      let offlineAt = 0;
      const monitor = sync && setInterval(() => {
        const status = sync.status();
        if (status.state === 'offline') offlineAt ||= Date.now(); else offlineAt = 0;
        if (status.state === 'conflict' || status.state === 'error' || offlineAt && Date.now() - offlineAt > 30_000) {
          syncFailure ??= syncError({ code: status.state === 'conflict' ? 'sync_conflict' : status.error });
          controller.abort(syncFailure);
        }
      }, 1000);
      monitor?.unref();
      try {
        const session = workspace.session({ keepAliveSeconds: 120 });
        const directoryName = introspection ? undefined : project.directoryName;
        process.exitCode = useLocalTui(args.argv, Boolean(process.stdin.isTTY && process.stdout.isTTY))
          ? await runLocalTui(new RemoteAgent(session, { ...(directoryName ? { directoryName } : {}), ...(sync ? { beforeSubmit: sync.flush } : {}) }), args.argv, project.workspace, process, controller.signal)
          : await runRemoteTerminal(session, args.argv, process, { ...(directoryName ? { directoryName } : {}), signal: controller.signal, term: process.env.TERM ?? 'xterm-256color' });
        if (syncFailure) throw syncFailure;
      } finally {
        if (monitor) clearInterval(monitor);
        await sync?.close();
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
      process.stderr.write('juiced: Cantelop credentials are missing or invalid. Run cantelop login and cantelop deploy in the Juiced project, then rebuild with npm run build.\n');
    } else if (code === 'session_runtime_mismatch') {
      process.stderr.write('juiced: the CLI and deployed runtime differ. Run npm run build and cantelop deploy from the same source.\n');
    } else process.stderr.write(`juiced: ${error instanceof Error ? error.message : 'Unable to start Claude'}\n`);
  }
  process.exitCode = interrupted || 1;
} finally {
  for (const { signal, handler } of handlers) process.off(signal, handler);
}
