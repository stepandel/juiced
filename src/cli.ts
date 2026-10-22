import { app as compiledApp } from './cantelop.js';
import { parseInvocation } from './account/invocation.js';
import { AccountClient, ManagedError } from './account/client.js';
import { VERSION } from './version.js';
import { updateEnvironment } from './environment.js';
import { configureGitHub, GITHUB_CONFIGURE_HELP } from './github-configure.js';
import { HELP, parseArguments } from './args.js';
import { ensureLogin } from './login.js';
import { runRemoteTerminal } from './remote-terminal.js';
import { useLocalTui } from './agent-protocol.js';
import { RemoteAgent } from './remote-agent.js';
import { runLocalTui } from './tui/app.js';
import { selectProject as selectProjectBase } from './project.js';
import { discoverRepository } from './git.js';
import { createGitSession, GitWorkspaceClient } from './git-workspace.js';
import { deleteWorkspace } from './delete-workspace.js';
import { inspectWorkspace } from './inspect-workspace.js';
import { syncFiles } from './file-sync.js';
import { prepareAgentSession } from './session-state.js';
import { terminalIdentity, usesTerminalSession } from './terminal-session.js';
import { listSessions } from './list-sessions.js';
import { LocalUploader } from './local-upload.js';
import { LocalPublisher } from './local-publish.js';
import { CliUpdater, needsCliUpdate } from './update.js';
import { ADMISSION_MESSAGE, isAdmissionTimeout } from './transport.js';
import { CliTelemetry } from './telemetry.js';

const controller = new AbortController();
let managedMode = true;
let commandStarted = false;
let updater = new CliUpdater();
let telemetry: CliTelemetry | undefined;
let interrupted = 0;
const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal, index) => {
  const handler = () => {
    interrupted = [130, 143, 129][index]!;
    controller.abort(new Error(`Received ${signal}`));
  };
  process.on(signal, handler);
  return { signal, handler };
});

/** One-shot commands keep retrying an unadmitted Session; say why they are waiting. */
const waitForAdmission = () => process.stderr.write(`juiced: ${ADMISSION_MESSAGE} Retrying for up to two and a half minutes…\n`);

async function main() {
  if (process.argv[2] === '--internal-install-completed') {
    const kind = process.argv[3];
    if (process.argv.length !== 4 || (kind !== 'fresh' && kind !== 'update')) return;
    try {
      const client = new AccountClient();
      telemetry = client.telemetry;
      telemetry.schedule(() => client.telemetry.capture(client.origin, 'cli_installed', { install_kind: kind }));
    } catch { /* Reporting must never fail an otherwise successful installation. */ }
    return;
  }
  const invocation = parseInvocation(process.argv.slice(2));
  managedMode = invocation.mode === 'managed';
  const accountEnv = {
    ...process.env,
    JUICED_MODE: invocation.mode,
    ...(invocation.service ? { JUICED_SERVICE_URL: invocation.service } : {}),
  };
  telemetry = new CliTelemetry(accountEnv);
  const accountClient = () => new AccountClient(accountEnv, fetch, telemetry);
  if (invocation.command === 'telemetry') {
    if (invocation.telemetryAction !== 'status') await telemetry.preference(invocation.telemetryAction === 'enable');
    process.stdout.write(`Juiced telemetry is ${await telemetry.enabled() ? 'enabled' : 'disabled'}.\n`);
    return;
  }
  const parsed = invocation.command ? undefined : parseArguments(invocation.args);
  const offline = parsed?.command === 'help' || parsed?.command === 'version' || invocation.command === 'logout';
  const introspectionOnly = parsed?.command === 'claude' && parsed.action === 'run' &&
    parsed.argv.length === 1 && ['--help', '-h', '--version', '-v'].includes(parsed.argv[0]!);
  if (managedMode && !offline && !introspectionOnly && invocation.command !== 'update') telemetry.firstRun(accountClient().origin);
  if (managedMode && !offline)
    updater = new CliUpdater({ serviceOrigin: accountClient().origin });
  if (invocation.command === 'update') {
    await updater.check(controller.signal, 'manual');
    return;
  }
  if (managedMode && !offline) {
    const command = await updater.check(controller.signal);
    if (command) {
      process.exitCode = await updater.restart(command, controller.signal);
      return;
    }
  }
  if (invocation.command) {
    commandStarted = true;
    const client = accountClient();
    if (invocation.command === 'login') await client.login(controller.signal, invocation.noBrowser);
    else if (invocation.command === 'whoami')
      process.stdout.write(JSON.stringify(await client.me(controller.signal), null, 2) + '\n');
    else {
      let failure;
      try {
        await client.json('/v1/logout', { all: invocation.all ?? false }, controller.signal);
      } catch (error) {
        if ((error as { status?: number }).status !== 401) failure = error;
      } finally {
        await client.store.locked(controller.signal, () => client.store.clear());
        await telemetry.resetIdentity();
      }
      if (failure)
        throw new Error('Local credentials removed; server revocation could not be confirmed.');
      process.stderr.write(
        invocation.all ? 'Signed out of all Juiced CLI sessions.\n' : 'Signed out of Juiced on this computer.\n',
      );
    }
  } else {
    const args = parsed!;
    const managed =
      managedMode && !['help', 'version'].includes(args.command)
        ? await accountClient().prepare(
            VERSION,
            compiledApp.runtimeId,
            invocation.account,
            controller.signal,
            (args.command === 'claude' && args.action === 'delete') ||
              (args.command === 'env' && args.action === 'unset'),
          )
        : undefined;
    commandStarted = true;
    const claudeApp = managed ? compiledApp.connect(managed.connection) : compiledApp;
    const selectProject = async (directory: string, workspace?: string) => {
      const project = await selectProjectBase(directory, workspace);
      if (managed) project.scope = managed.scope;
      return project;
    };
    if (args.command === 'help')
      process.stdout.write(args.argv[0] === 'github-configure' ? GITHUB_CONFIGURE_HELP : HELP);
    else if (args.command === 'version') process.stdout.write(`juiced ${VERSION}\n`);
    else if (args.command === 'env') {
      await updateEnvironment(
        claudeApp.environment(),
        args.action,
        args.name,
        args.secret,
        process,
        controller.signal,
      );
    } else if (args.command === 'claude' && args.action === 'github-configure') {
      await configureGitHub(claudeApp.environment(), args.stdin, process, controller.signal);
    } else if (args.command === 'claude' && args.action === 'sessions') {
      await listSessions(claudeApp, process.cwd(), args.workspace, controller.signal, process.stdout, waitForAdmission);
    } else if (args.command === 'claude' && (args.action === 'ls' || args.action === 'peek')) {
      process.exitCode = await inspectWorkspace(claudeApp, process.cwd(), { ...args, waiting: waitForAdmission }, controller.signal);
    } else if (args.command === 'claude' && args.action === 'delete') {
      const project = await selectProject(process.cwd(), args.workspace);
      await deleteWorkspace(claudeApp, project.workspace, args.yes, controller.signal);
    } else if (args.command === 'claude' && args.action === 'file-sync') {
      const project = await selectProject(process.cwd(), args.workspace);
      await syncFiles(
        claudeApp.workspace({ slug: project.workspace }),
        project,
        args.watch,
        controller.signal,
      );
    } else if (args.command === 'claude') {
      const project = await selectProject(process.cwd(), args.workspace);
      if (process.stderr.isTTY)
        process.stderr.write(`Connecting to Cantelop workspace ${project.workspace}…\n`);
      const resolved = await claudeApp.workspace({ slug: project.workspace }).resolve();
      if (managed) project.scope = `${managed.scope}:${resolved.id}`;
      const workspace = claudeApp.workspace({ id: resolved.id });
      const introspection =
        args.action === 'run' &&
        args.argv.length === 1 &&
        ['--help', '-h', '--version', '-v'].includes(args.argv[0]!);
      const maintenance = args.action === 'sync' || args.action === 'fast-forward';
      if (!introspection && !maintenance) await ensureLogin(workspace.auth(), controller.signal);
      if (args.action === 'login')
        process.stderr.write(
          `Ready. Run juiced${args.workspace ? ` --workspace ${args.workspace}` : ''} claude from this directory.\n`,
        );
      else {
        const repository = introspection
          ? undefined
          : await discoverRepository(project.localDirectory);
        if (maintenance) {
          if (!repository)
            throw new Error('Git workspace commands require a local Git repository.');
          const client = new GitWorkspaceClient(workspace, project, repository, controller.signal, waitForAdmission);
          try {
            if (args.action === 'sync' && args.direction === 'to-workspace') {
              await client.send(args.includeUncommitted);
              process.stderr.write(`Transferred local work to ${project.workspace}.\n`);
            } else {
              const result =
                args.action === 'fast-forward'
                  ? await client.fastForward()
                  : await client.receive();
              process.stderr.write(
                args.action === 'fast-forward'
                  ? `Fast-forwarded ${repository.branch} to ${result.head.slice(0, 12)}.\n`
                  : `Imported ${result.head.slice(0, 12)} into ${result.ref}.\n`,
              );
            }
          } finally {
            await client.close().catch(() => {});
          }
        } else {
          const localTui = useLocalTui(
            args.argv,
            Boolean(process.stdin.isTTY && process.stdout.isTTY),
          );
          if (args.session && !localTui)
            throw new Error('Juiced session recovery requires an interactive terminal.');
          const automaticResume =
            args.action === 'run' &&
            localTui &&
            !args.session &&
            usesTerminalSession(args.argv, args.newSession);
          const terminal = automaticResume ? await terminalIdentity() : undefined;
          if (automaticResume && !terminal)
            process.stderr.write(
              'juiced: Could not identify this terminal session; automatic resume is unavailable.\n',
            );
          const selected = localTui
            ? await prepareAgentSession(project, {
                ...(args.session ? { explicit: args.session } : {}),
                // Reattaching keeps the saved launch configuration. New Claude
                // arguments must start a new session so prompts and flags take effect.
                ...(args.action === 'run' && (args.newSession || (terminal && args.argv.length > 0))
                  ? { fresh: true }
                  : {}),
                ...(terminal ? { terminal: { identity: terminal, workspaceId: resolved.id } } : {}),
              })
            : undefined;
          if (repository && !selected?.resumed) {
            if (process.stderr.isTTY)
              process.stderr.write(`Preparing Git workspace ${project.remoteDirectory}…\n`);
            const client = new GitWorkspaceClient(
              workspace,
              project,
              repository,
              controller.signal,
              waitForAdmission,
            );
            try {
              await client.send(false, true);
            } finally {
              await client.close().catch(() => {});
            }
          }
          await selected?.save();
          const id = selected?.id;
          if (terminal && selected?.resumed)
            process.stderr.write(
              `Reconnecting to Juiced session ${id}. Use juiced claude --new to start fresh.\n`,
            );
          const session = repository
            ? createGitSession(
                workspace,
                project,
                id,
                managed
                  ? (session) => managed.stop(session, resolved.id, project.directoryName)
                  : undefined,
              )
            : workspace.session({ keepAliveSeconds: 120, ...(id ? { id } : {}) });
          const directoryName = introspection ? undefined : project.directoryName;
          const git = repository
            ? { binding: repository.binding, relativeDirectory: repository.relativeDirectory }
            : undefined;
          const publisher =
            repository && localTui ? new LocalPublisher(workspace, project, repository) : undefined;
          const usage = managed && !introspection ? accountClient() : undefined;
          const properties = { session_mode: localTui ? 'interactive' as const : 'terminal' as const };
          let connected = false, lastActivity = -Infinity;
          const onConnected = () => {
            if (connected) return;
            connected = true;
            usage?.track('cli_session_connected', properties);
          };
          const onActivity = () => {
            if (!connected || Date.now() - lastActivity < 300000) return;
            lastActivity = Date.now();
            usage?.track('cli_session_active', properties);
          };
          if (localTui) {
            const agent = new RemoteAgent(session, {
              ...(directoryName ? { directoryName } : {}),
              ...(git ? { git } : {}),
              ...(publisher && repository
                ? {
                    localPublish: {
                      head: repository.head,
                      upload: new LocalUploader(workspace, project, repository),
                      apply: (publication, signal) => publisher.apply(publication, signal),
                    },
                  }
                : {}),
            });
            agent.on('status', status => { if (status === 'ready' || status === 'working') onConnected(); });
            agent.on('activity', onActivity);
            const activity = setInterval(() => { if (agent.status === 'working') onActivity(); }, 300000);
            activity.unref();
            try {
              process.exitCode = await runLocalTui(
                agent,
                args.argv,
                project.workspace,
                process,
                controller.signal,
              );
            } finally { clearInterval(activity); }
          } else {
            process.exitCode = await runRemoteTerminal(session, args.argv, process, {
              ...(directoryName ? { directoryName } : {}),
              ...(git ? { git } : {}),
              signal: controller.signal,
              term: process.env.TERM ?? 'xterm-256color',
              // Headless runs carry their work in argv; an idle interactive terminal is not activity.
              onConnected: () => { onConnected(); if (!(process.stdin.isTTY && process.stdout.isTTY)) onActivity(); },
              onActivity,
            });
          }
        }
      }
    }
  }
}

async function reportError(error: unknown) {
  const code = (error as { code?: string }).code;
  if (process.env.JUICED_DEBUG) {
    const detail = error as Error & {
      code?: string;
      status?: number;
      cause?: Error & { code?: string };
    };
    process.stderr.write(
      JSON.stringify({
        name: detail.name,
        message: detail.message,
        code: detail.code,
        status: detail.status,
        stack: detail.stack,
        cause: detail.cause
          ? { name: detail.cause.name, message: detail.cause.message, code: detail.cause.code }
          : undefined,
      }) + '\n',
    );
  }
  if (!interrupted) {
    if (
      code === 'app_configuration_missing' ||
      code === 'app_configuration_invalid' ||
      code === 'app_not_configured'
    ) {
      process.stderr.write(
        'juiced: Cantelop app credentials are missing or invalid. Configure the SDK integration profile or set CANTELOP_APP_SLUG, CANTELOP_INTEGRATION_TOKEN, and optionally CANTELOP_EDGE_URL. See docs/self-managed.md for deployment setup.\n',
      );
    } else if (isAdmissionTimeout(error)) {
      process.stderr.write(
        `juiced: ${ADMISSION_MESSAGE} Nothing was changed and remote work is preserved. Wait a minute, then run the command again; reopen a saved conversation with juiced claude --session ID (see juiced claude sessions).\n`,
      );
    } else if (code === 'managed_admission_closed') {
      process.stderr.write(`juiced: ${new ManagedError(code).message}\n`);
    } else if (needsCliUpdate(error)) {
      if (managedMode) {
        process.stderr.write('juiced: This CLI and the service runtime are incompatible. Checking for a required update…\n');
        try {
          const command = await updater.check(controller.signal, 'mismatch');
          if (command && !commandStarted) {
            process.exitCode = await updater.restart(command, controller.signal);
            return;
          }
          process.stderr.write('juiced: Updated successfully. Run your command again to reconnect.\n');
        } catch (updateError) {
          if (!interrupted)
            process.stderr.write(`juiced: ${updateError instanceof Error ? updateError.message : 'Run juiced update, then retry.'}\n`);
        }
      } else {
        process.stderr.write('juiced: The CLI and deployed runtime differ. Run npm run build and cantelop deploy from the same source, then retry your command.\n');
      }
    } else
      process.stderr.write(
        `juiced: ${error instanceof Error ? error.message : 'Unable to start Claude'}\n`,
      );
  }
  process.exitCode = interrupted || (code === 'inspection_incomplete' ? 2 : 1);
}

try {
  await main();
} catch (error) {
  await reportError(error);
} finally {
  await telemetry?.flush();
  for (const { signal, handler } of handlers) process.off(signal, handler);
}
