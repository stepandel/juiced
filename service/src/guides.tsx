import type { ReactNode } from 'react';
import { Shell } from '../app/shell';

export const guides: {
  slug: string;
  label: string;
  title: string;
  description: string;
  body: ReactNode;
}[] = [
  {
    slug: 'getting-started',
    label: 'Getting started',
    title: 'Get started with Juiced',
    description:
      'Requirements, Juiced account sign-in, Claude Code login, and your first persistent cloud workspace.',
    body: (
      <>
        <h2>What you need</h2>
        <ul>
          <li>Node.js 22 or later on the machine running the Juiced CLI.</li>
          <li>Git for working with a Git repository.</li>
          <li>
            A Juiced account with managed access, or your own configured
            Cantelop deployment.
          </li>
          <li>
            Your own Claude account with Claude Code access. Juiced does not
            include Claude model usage.
          </li>
        </ul>
        <p>
          See <a href="/pricing">pricing</a> for managed access. For building
          the CLI from source or configuring a self-managed deployment, follow
          the{' '}
          <a href="https://github.com/stepandel/juiced#readme">
            repository setup guide
          </a>
          .
        </p>
        <h2>Sign in to Juiced</h2>
        <p>
          With the CLI installed, sign in to your Juiced account using GitHub or
          Google. This account controls your managed workspaces and compute.
        </p>
        <Shell>{'juiced login\njuiced whoami'}</Shell>
        <p>
          For a terminal without a browser, use{' '}
          <code>juiced login --no-browser</code>.
        </p>
        <h2>Open your project and sign in to Claude</h2>
        <p>
          Change to your project directory before signing in to Claude. The
          directory selects your workspace. Claude login is separate from Juiced
          account login and is saved in that workspace.
        </p>
        <Shell>{'cd your-project\njuiced claude login\njuiced claude'}</Shell>
        <p>
          Follow the Claude sign-in URL and enter the returned authorization
          code in your terminal. You can review Claude Code access requirements
          in{' '}
          <a href="https://code.claude.com/docs/en/authentication">
            Anthropic’s authentication documentation
          </a>
          .
        </p>
        <h2>Ask Claude to work</h2>
        <p>
          Type a prompt in your local terminal. Claude’s tools run in the cloud
          workspace. For a Git repository, the first launch copies committed
          history from your local HEAD; uncommitted files require an explicit
          transfer.
        </p>
        <p>
          Use <code>/detach</code> to leave a turn running, then run{' '}
          <code>juiced claude</code> in the same terminal tab and project to
          reconnect.
        </p>
        <h2>Review and bring back the result</h2>
        <Shell>
          {
            'juiced claude peek --changes-only\njuiced claude sync --from-workspace'
          }
        </Shell>
        <p>
          The import brings back commits without changing your local files.
          Follow the <a href="/docs/syncing-code">Git transfer guide</a> to
          review and apply them. Learn{' '}
          <a href="/docs/workspaces-and-sessions">
            what persists between sessions
          </a>{' '}
          before starting another project.
        </p>
      </>
    ),
  },
  {
    slug: 'workspaces-and-sessions',
    label: 'Workspaces and sessions',
    title: 'Workspaces, sessions, and persistence',
    description:
      'What Juiced saves, how project isolation works, and how to detach from and reconnect to Claude Code.',
    body: (
      <>
        <h2>A workspace belongs to a project</h2>
        <p>
          Juiced selects a persistent cloud workspace from your local project
          path. Two directories with the same name stay separate because the
          selection includes a hash of the resolved path. Linked Git worktrees
          are supported.
        </p>
        <p>
          A workspace keeps your remote code, Claude login, and saved
          conversations between runs. Workspaces do not share files or Claude
          credentials.
        </p>
        <p>
          To choose a workspace explicitly, put the option before the command:
        </p>
        <Shell>{'juiced --workspace my-project claude'}</Shell>
        <h2>Detach while Claude keeps working</h2>
        <p>
          Enter <code>/detach</code> or close your terminal to disconnect while
          the remote turn continues. Your laptop does not need to stay connected
          for the cloud process to work. Completion, errors, permission
          requests, and compute limits can still stop or pause progress.
        </p>
        <p>
          <code>/exit</code> and <code>/quit</code> stop the remote process.
          During a turn, Esc or Ctrl+C interrupts Claude.
        </p>
        <h2>Reconnect to the same conversation</h2>
        <p>
          Run <code>juiced claude</code> in the same terminal tab, project, and
          workspace to reconnect to its saved session. From another tab, list
          the sessions and select the ID you want:
        </p>
        <Shell>{'juiced claude sessions\njuiced claude --session ses_…'}</Shell>
        <p>
          Start a fresh conversation with <code>juiced claude --new</code>. A
          new conversation uses the same project workspace and files.
        </p>
        <h2>Persistent files, temporary compute</h2>
        <p>
          Claude runs in a sandbox attached to the workspace. Idle compute shuts
          down while the workspace data remains available for later runs.
          Disconnecting does not mean a process will run forever.
        </p>
        <p>
          Local and cloud files are separate. Normal launches do not reconcile
          them. See <a href="/docs/syncing-code">how code transfers work</a>, or
          read the{' '}
          <a href="/docs/remote-claude-code">
            guide to running Claude Code with your laptop closed
          </a>
          .
        </p>
      </>
    ),
  },
  {
    slug: 'syncing-code',
    label: 'Syncing code',
    title: 'Move code between your laptop and the cloud',
    description:
      'Send commits and local edits to Juiced, inspect remote changes, and import or fast-forward results explicitly.',
    body: (
      <>
        <h2>The first launch copies committed history</h2>
        <p>
          In a Git repository, Juiced initializes the remote checkout from your
          exact local HEAD, including unpublished commits. Later launches reuse
          that checkout. Uncommitted local edits are not included automatically.
        </p>
        <h2>Send local commits or edits</h2>
        <Shell>
          {
            'juiced claude sync --to-workspace\n# Also send staged, unstaged, and non-ignored untracked files:\njuiced claude sync --to-workspace --include-uncommitted'
          }
        </Shell>
        <p>
          Close the workspace’s running sessions before using these upload
          commands. An existing remote checkout must be clean and able to
          fast-forward to the uploaded commit. Your local files and index stay
          untouched.
        </p>
        <p>
          Git ignore rules control which untracked files travel with a snapshot.
          Tracked files are included even when an ignore pattern matches them.
          Review what you are sending, especially tracked configuration files.
        </p>
        <h2>Inspect cloud changes</h2>
        <Shell>{'juiced claude ls\njuiced claude peek --changes-only'}</Shell>
        <p>
          Inspection compares local and remote files without applying changes or
          spending a Claude model turn.
        </p>
        <h2>Import commits for review</h2>
        <Shell>
          {
            'juiced claude sync --from-workspace\ngit log --oneline --all --decorate'
          }
        </Shell>
        <p>
          Importing stores remote commits under Juiced’s Git refs. It does not
          move your current branch or change your working files. Ask Claude to
          commit remote work before importing; remote uncommitted edits stay in
          the cloud.
        </p>
        <h2>Apply results to your local branch</h2>
        <Shell>juiced claude fast-forward</Shell>
        <p>
          This command imports results and explicitly advances the original
          local branch when the working tree is clean and history can
          fast-forward. It refuses detached HEADs, branch changes, dirty files,
          and divergent history. It does not merge, reset, rebase, or stash your
          work.
        </p>
        <p>
          Claude can also request publication during an interactive session.
          Those requests require approval in your local terminal. See the{' '}
          <a href="https://github.com/stepandel/juiced/blob/main/docs/local-publication.md">
            publication reference
          </a>{' '}
          for commit and snapshot behavior.
        </p>
        <h2>Directories without Git</h2>
        <p>
          A non-Git project starts with an empty remote folder. Explicit file
          sync is available on macOS and Linux, on arm64 and x64:
        </p>
        <Shell>
          {
            'juiced claude sync --files\n# Keep syncing in a separate terminal:\njuiced claude sync --files --watch'
          }
        </Shell>
        <p>
          File sync is bidirectional, including deletions after its first
          reconciliation. Conflicts preserve both copies and stop the command.
          Git repositories use the commit and snapshot commands above.
        </p>
      </>
    ),
  },
  {
    slug: 'remote-claude-code',
    label: 'Running with your laptop closed',
    title: 'Keep Claude Code running with your laptop closed',
    description:
      'Run Claude Code in a persistent cloud workspace, detach from your terminal, and reconnect to review its work.',
    body: (
      <>
        <h2>Where Claude runs matters</h2>
        <p>
          A Claude Code process running on your laptop depends on that machine
          staying awake. Juiced runs Claude Code and its tools in a cloud
          sandbox; your terminal is the interface to that process.
        </p>
        <h2>Start, detach, and return</h2>
        <Shell>
          {
            'juiced claude\n# Submit your task, then enter this in Juiced:\n/detach\n# Later, from the same project and terminal tab:\njuiced claude'
          }
        </Shell>
        <p>
          The remote turn continues after you detach or close your terminal.
          Reconnecting lets you see the session and respond to anything that
          needs input. A task can pause for permission or stop because of an
          error or usage limit; detaching does not guarantee unattended
          completion.
        </p>
        <h2>What stays in the cloud?</h2>
        <p>
          The workspace retains code, Claude login, and conversation history.
          The compute sandbox can shut down when idle. Starting another session
          reuses the workspace’s saved state.
        </p>
        <h2>Will my local files change?</h2>
        <p>
          Normal Claude sessions do not automatically apply remote edits to your
          laptop. Use explicit{' '}
          <a href="/docs/syncing-code">Git transfers and review</a>, or approve
          an interactive publication request.
        </p>
        <h2>Do I need a Claude subscription?</h2>
        <p>
          You bring your own Claude Code access and sign in inside the
          workspace. Juiced provides the infrastructure; Claude model access and
          usage remain separate. Check{' '}
          <a href="https://code.claude.com/docs/en/authentication">
            Anthropic’s current account requirements
          </a>{' '}
          for your login.
        </p>
        <p>
          Start with the <a href="/docs/getting-started">setup guide</a> or
          compare <a href="/docs/juiced-vs-vps">Juiced with a VPS</a>.
        </p>
      </>
    ),
  },
  {
    slug: 'juiced-vs-vps',
    label: 'Juiced vs a VPS',
    title: 'Juiced vs a VPS for Claude Code',
    description:
      'Compare Juiced’s cloud workspaces and terminal sessions with managing Claude Code on your own virtual server.',
    body: (
      <>
        <h2>Both approaches move execution off your laptop</h2>
        <p>
          A VPS can run Claude Code remotely if you configure it to keep the
          process alive after disconnecting. Juiced provides a project
          workspace, a local terminal interface, session reconnection, and code
          transfer commands on top of Cantelop infrastructure.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Managed Juiced</th>
                <th scope="col">Your own VPS</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Set up the environment</th>
                <td>Juiced provisions the workspace and runtime.</td>
                <td>
                  You install and maintain the server, runtime, and Claude Code.
                </td>
              </tr>
              <tr>
                <th scope="row">Keep work running</th>
                <td>Detach and reconnect through Juiced sessions.</td>
                <td>
                  Configure process supervision or a terminal multiplexer.
                </td>
              </tr>
              <tr>
                <th scope="row">Separate projects</th>
                <td>Each workspace keeps separate files and Claude login.</td>
                <td>Choose and configure your own isolation.</td>
              </tr>
              <tr>
                <th scope="row">Transfer code</th>
                <td>
                  Initial Git checkout, explicit uploads, imports, and
                  fast-forwards.
                </td>
                <td>Arrange Git access or your own file transfers.</td>
              </tr>
              <tr>
                <th scope="row">Manage idle compute</th>
                <td>Idle sandboxes shut down; workspace state persists.</td>
                <td>Configure shutdown and storage persistence yourself.</td>
              </tr>
              <tr>
                <th scope="row">Claude access</th>
                <td>Bring your own Claude Code login.</td>
                <td>Bring your own Claude Code login.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <h2>Choose based on what you want to manage</h2>
        <p>
          Juiced suits a terminal workflow where you want workspace and session
          handling built in. A VPS suits a setup where you want to choose and
          operate the whole server yourself. A server can also host other
          services you configure.
        </p>
        <p>
          Juiced also supports a self-managed Cantelop deployment. That setup
          requires your own infrastructure configuration; see the{' '}
          <a href="https://github.com/stepandel/juiced#readme">
            repository guide
          </a>
          .
        </p>
        <p>
          Review <a href="/pricing">Juiced pricing</a> and the{' '}
          <a href="/docs/getting-started">getting started guide</a>.
        </p>
      </>
    ),
  },
  {
    slug: 'telemetry',
    label: 'Telemetry',
    title: 'CLI telemetry',
    description: 'What Juiced measures and how to control optional CLI analytics.',
    body: (
      <>
        <h2>What is collected</h2>
        <p>When the service enables analytics, Juiced reports completed installs, first runs,
          successful Juiced logins, session connections, and basic session activity to PostHog.
          Events include CLI version, OS, architecture, and a random installation ID.
          After login, an opaque user ID connects usage across your computers.</p>
        <p>Analytics never includes prompts, source code, terminal output, command arguments,
          file paths, repository names, email addresses, or credentials. PostHog GeoIP enrichment
          is disabled. Hosting and authentication logs are separate.</p>
        <h2>Control collection</h2>
        <Shell>{'juiced telemetry status\njuiced telemetry disable\n# To enable again:\njuiced telemetry enable'}</Shell>
        <p>The preference is stored on this computer and survives upgrades. Set
          {' '}<code>JUICED_TELEMETRY_DISABLED=1</code> or <code>DO_NOT_TRACK=1</code> to
          override it. CI and self-managed mode disable product telemetry.</p>
        <Shell>{'curl -fsSL https://juiced.codes/install.sh | JUICED_TELEMETRY_DISABLED=1 sh'}</Shell>
        <p>For future CLI runs, also set the environment variable in your shell or run
          {' '}<code>juiced telemetry disable</code> after installing. Telemetry settings
          work offline. Reporting failures never fail an installation or command.</p>
        <h2>How activity is measured</h2>
        <p>A session connection is counted after the agent or terminal is ready.
          Activity is recorded when input is accepted or an attached interactive agent is
          working, at most once per five minutes per CLI process. Idle sessions do not
          emit activity. Logout resets the anonymous identity used for account linking;
          the installation ID survives. Deleting local configuration creates a new ID.</p>
      </>
    ),
  },
];
