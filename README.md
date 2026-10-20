# Juiced

File sync is off by default. Git repositories initialize from local `HEAD` once; later transfers are explicit. Non-Git directories use a persistent remote project folder, initially empty, with optional file sync through `juiced claude sync --files [--watch]`. See [Git workspaces](docs/git-workspaces.md) for snapshot transfer, importing commits, optional fast-forwarding, and migration from file sync.

Run the real Claude Code CLI in a Cantelop session, attached to your local terminal:

```sh
juiced claude
```

Interactive invocations open the **Juiced TUI on your machine**, connected to a headless Claude Code process on Cantelop. Typing, cursor movement, multiline editing, and pasting happen locally. Submitted prompts, menu data requests, confirmed actions, permission answers, and interrupts cross the network. Claude's agent loop, tools, files, and authentication stay in the persistent remote workspace. Git repositories upload local `HEAD` on first launch; local uncommitted files are included only through an explicit transfer.

The local interface streams Claude's responses, shows tool activity, and asks before actions that Claude requires permission to run. Rerunning `juiced claude` in the same terminal tab, project, and workspace reconnects to that tab's session. Use `juiced claude --new` to start fresh. List saved conversations with `juiced claude sessions`, then reopen one with `juiced claude --session ses_…`. Its ID is also displayed in the session header. Piped commands and explicit `-p`, `--help`, and `--version` invocations retain the native CLI passthrough.

## Set up

Running Juiced needs Node.js 22+ and configured Cantelop app credentials. The
[Cantelop CLI](https://cantelop.com/docs) and Docker are deployment tools used for
the initial runtime setup.

From this project directory:

```sh
npm install
npm run build
cantelop login
cantelop deploy
npm link
```

The app is named `juiced` in `src/cantelop.ts`. If you need another deployment name, change that literal before building and deploying. Build the CLI and deploy the runtime from the same source: Cantelop checks their runtime identities. Deployment saves app credentials in your local Cantelop integration profile, which Juiced reads automatically.

Sign in to Claude once for your remote workspace:

```sh
juiced claude login
juiced claude
```

`juiced claude login` prints Claude's sign-in URL and asks for the returned authorization code. The native Claude login runs inside Cantelop; credentials persist in the workspace. Interactive `juiced claude` also starts this login flow when needed. Piped commands require an existing login.

Commands that use a harness's runtime and authentication live under its name.
Claude sign-in is `juiced claude login`; there is no top-level `juiced login`.

`juiced claude --version` and `juiced claude --help` work before Claude sign-in and can verify connectivity to the deployed runtime.

The local UI uses Claude's programmatic mode in the remote workspace you have chosen. It does not run native terminal onboarding or show a remote folder-trust dialog. Claude's own tool permission checks remain active; permission requests appear in Juiced with **Deny** selected by default. Permission grants apply once, without changing stored permission rules. `AskUserQuestion` prompts accept a typed answer or an option number.

## GitHub access

Configure GitHub with one command:

```sh
juiced claude github-configure
```

Juiced uses `GH_TOKEN` from your shell or an existing local `gh` credential for
github.com. If neither is available, it opens GitHub's token creation page and
asks you to paste the token with input hidden. Choose the repository owner and
repositories; grant **Contents: Read and write** for pushing and **Pull requests:
Read and write** for opening PRs. Add **Workflows: Write** if the agent should edit
workflow files. See [GitHub's token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Setup shows three steps: finding a credential, verifying the GitHub account, and
saving `GH_TOKEN` as an app secret while waiting for propagation. It runs locally
and keeps your Claude conversations unchanged.

To pick up the new token in an **existing conversation**, use `/exit` if Claude
is still running, then run `juiced claude` from the same terminal tab, project,
and workspace. If the original tab is closed, use `juiced claude --session ID`
with the session ID from its header. This restarts the remote process with the
updated environment and preserves the same
conversation and history. `/detach` leaves the existing process running with its
previous credentials. If you have not started a conversation yet, run
`juiced claude` normally.
The local `gh` CLI is optional. To supply or rotate a specific token instead of
reusing an existing credential, pipe it explicitly (on macOS, after copying it):

```sh
pbpaste | juiced claude github-configure --stdin
```

You can also manage the token directly through the generic environment commands:

```sh
printf '%s' "$GH_TOKEN" | juiced env set GH_TOKEN --stdin
juiced env unset GH_TOKEN
```

Values are Cantelop secrets by default. `--plain` selects an ordinary variable
that the deployed app declares. Input is read from stdin, with one trailing
newline removed; values never appear in command arguments or Juiced output.
The command uses the SDK and the existing app integration credential. It needs
neither the Cantelop CLI nor Claude sign-in, and waits until Edge and compute
configuration have applied the update. Token changes require no deployment.

Configuration is app-wide, across all of its workspaces. New remote processes
receive the updated token; already-running processes keep their environment until
they exit. Resuming a conversation after `/exit` reloads it with the updated
configuration. The runtime supplies `GH_TOKEN` to Claude and uses `gh` as Git's HTTPS
credential helper. Scope the token to the intended repositories and permissions.
Normal GitHub branch protection and token permissions still apply.

Git workspaces copy remote URLs and source-branch tracking settings separately
from repository contents. GitHub SSH URLs become HTTPS URLs for token access.
Starting Juiced refreshes this metadata even for existing workspaces, without
replacing their files, index, commits, or current branch. Close active sessions
before changing managed remote settings. See [Git workspaces](docs/git-workspaces.md).

This feature requires SDK 1.4.0 and the platform environment API. Deploy the new
platform and Juiced runtime once; later token rotations are configuration updates.

## Use

Arguments after `claude` configure the remote Claude process, except for Juiced's reserved `login`, `sync`, `fast-forward`, `delete`, `ls`, `peek`, and `sessions` subcommands and the leading `--new` and `--session ID` options. Use `juiced claude -- login` to send a literal prompt named `login`. Interactive launches add the JSON transport flags needed by the local UI. Explicit print/introspection/output-format invocations use native passthrough:

```sh
juiced claude --model sonnet
juiced claude --new # Start fresh and replace this terminal tab's session binding
juiced claude sessions # List saved Juiced conversations, newest first
juiced claude --session ses_<id> # Reopen a listed conversation
juiced claude --help
juiced claude -p "Explain the repository in this workspace"
cat prompt.txt | juiced claude -p
juiced claude -p "Summarize the project" > summary.txt
```

Terminal bindings use a terminal session ID, a tmux/screen pane ID, or the parent
shell's PID and start time. Each tab, local project directory, and canonical
remote workspace gets a separate binding. Deleting and recreating a workspace
starts fresh. Only session IDs are saved locally in `.cantelop/juiced/`; submitted
prompts, responses, and conversation state stay in the remote workspace.

Use `juiced claude --new [Claude arguments...]` to replace the current tab's
binding. Supplying Claude arguments, such as `--model sonnet` or an initial
prompt, also starts a fresh bound session so those arguments take effect; a plain
`juiced claude` reconnects. A leading Juiced `--session ID` after `claude`, Claude
session-selection flags after it (such as `--resume`, `--continue`, or
`--session-id`), and `--no-session-persistence` bypass the terminal binding.
Pipes, print mode, help, and version commands also bypass it. If Juiced cannot
identify the terminal, it reports that automatic resume is unavailable and
starts normally; explicit Juiced session recovery remains available.

`juiced claude sessions` lists remote Juiced conversation IDs and their last
update times for the current project and workspace, including sessions from
other tabs and older sessions replaced with `--new`. It works with piped output
and app credentials, without starting Claude, signing in, or syncing files.
A missing workspace stays uncreated. Git sessions are filtered by repository
binding and launch directory. Native passthrough sessions have no Juiced history
and are excluded. See [session recovery](docs/session-recovery.md) for older
histories whose IDs were not saved by earlier runtimes.

Select another persistent workspace with an option **before** the command:

```sh
juiced --workspace my-project claude login
juiced --workspace my-project claude
# Or choose a default for this shell:
export JUICED_WORKSPACE=my-project
```

The current directory selects a persistent workspace automatically. The slug is
its folder name plus a stable hash of its resolved absolute path, so two projects
with the same folder name remain separate. `--workspace` or `JUICED_WORKSPACE`
overrides that selection. Workspaces share neither files nor Claude login.

Claude starts in `/workspace/<folder-name>`. For a Git repository, the first
launch initializes a checkout from local `HEAD`; later launches reuse the remote
checkout. Use `juiced claude sync --to-workspace` to send subsequent commits, or
add `--include-uncommitted` to send local edits. Import remote commits explicitly
with `juiced claude sync --from-workspace` and optionally apply them with
`juiced claude fast-forward`.

Non-Git directories start in a persistent remote project folder that is created
empty on first use. Existing remote files are retained. Normal Claude launches
do not upload, download, or reconcile files before prompts, tool approvals, or
exit. To explicitly sync a non-Git folder:

```sh
# Reconcile files in both directions once, then exit:
juiced claude sync --files
# Or keep syncing in a separate terminal until Ctrl+C:
juiced claude sync --files --watch
```

Both commands use the selected workspace and its matching project folder. They
need Cantelop app credentials and do not start Claude or require Claude sign-in.
The SDK's bundled adapter syncs files on macOS and Linux (arm64 and x64), without
the Cantelop CLI. `.git`, `.cantelop`, `.env*`, `node_modules`, `dist`, and
`coverage` are excluded. File sync is bidirectional, including deletions after
the first reconciliation. Conflicting edits preserve both copies and stop the
command. Watch mode stops after 30 seconds offline and releases its local lock
on exit; one local directory can have one active sync command.

File sync is for non-Git folders. In Git repositories, use `sync --to-workspace`
or `sync --from-workspace` to transfer commits and snapshots explicitly.

Claude's HOME and account state remain at `/workspace`, including `.claude` and
`.local`. Each project workspace needs its own Claude login. An existing login
is retained in its original workspace; pass `--workspace default` to reuse the
previous default workspace.

In the local UI:

- **Enter** submits the complete prompt when Claude is ready.
- **Alt+Enter**, **Shift+Enter** in terminals that support it, or **`\` then Enter** inserts a newline. Multiline paste stays in the editor until you submit.
- Arrow keys, Home/End, backspace/delete, Ctrl+A/E, Ctrl+U/K/W edit the local draft, including Unicode characters.
- **Esc** or **Ctrl+C** during a turn interrupts Claude. You can draft your next prompt while it works; Enter keeps that draft until the current turn finishes.
- **Ctrl+C** while idle clears the draft. With an empty draft, press **Ctrl+C** or **Ctrl+D** twice within a second to exit; **`/exit`** and **`/quit`** also disconnect and stop the remote process.
- **Esc** twice while idle clears the draft. **↑/↓** on the first or last line of the draft recall earlier prompts from this session.
- **Shift+Tab** cycles the permission mode between manual (default), accept edits, and plan. Like the `/permissions` picker, the change is saved for future sessions in that workspace. **`?`** in an empty prompt shows the keyboard shortcuts.
- The interface follows Claude Code's layout: a `❯` prompt between rules with the permission mode below it, `●` responses with rendered Markdown, `Tool(args)` calls with a `⎿` result summary, a spinner with elapsed time and an estimated token count, and permission dialogs with numbered choices. Finished reads and searches fold into one summary line. Juiced keeps its own colors, and **No** stays the default choice in tool approvals.
- **`/detach`** disconnects while remote work continues. Closing the terminal also detaches. Reattach with **`juiced claude`** in the same tab, or **`juiced claude --session ID`** from another tab in the same project and workspace.
- **`/`** previews available commands with descriptions and argument hints. Suggestions appear above the prompt. Keep typing to filter, use **↑/↓** to select, **Tab** to complete before adding arguments, and **Enter** to run the selection. **Esc** closes the menu without changing your draft.
- **`/model`**, **`/effort`**, **`/output-style`**, **`/config`**, **`/permissions`**, and **`/mcp`** open local menus. Model choices, effort levels, styles, and servers come from the remote Claude session. Use **↑/↓** to navigate, type to filter, **Enter** to confirm, and **Esc** to go back. **`/model <name>`** also accepts a full model ID. Changes keep the current conversation and do not submit a model prompt.
- Confirmed model, effort, output style, fast mode, and permission mode changes are saved in `/workspace/.claude/settings.json` for future sessions in that workspace, including launches from another machine. Explicit Claude flags override saved defaults for that invocation. Individual tool approvals remain one-time grants. A failed save is reported while the running session keeps the applied choice.
- **`/context`**, **`/usage`**, **`/memory`**, **`/hooks`**, **`/agents`**, **`/skills`**, **`/plugins`**, **`/tasks`**, and **`/status`** open local data views. **`/rename`** opens a name editor. Some views are read-only because the pinned headless protocol lacks the native editing APIs; see [menu coverage and limitations](docs/local-command-menus.md).
- **`/help`** opens the command browser and local shortcuts. Suggestions include Juiced's local commands and commands reported by the remote Claude session, including its project skills, aliases, and custom commands. Recognized native-only screens such as **`/resume`** and **`/rewind`** explain their availability locally rather than submitting a model prompt.

Submitted prompts and controls use ordered requests with stable delivery identities. Each complete JSON frame is acknowledged after native stdin handoff; retries reuse its identity. Responses and permission requests stream independently. Network latency affects submission and response arrival, but cannot delay local typing. Prompts are limited to 512 KiB, pending input to 1 MiB, and encoded interactive frames to 768 KiB. Native stdin writes remain fragmented to 16 KiB.

Interactive work continues when the laptop sleeps or loses connectivity; no client heartbeat owns its lifetime. The TUI retries transient connection failures until it reconnects or you exit, and recovers missed output from the workspace journal even when Cantelop's replay cursor has expired. Drafts remain local while the same TUI is open. Responses, submitted prompts, and pending permission requests can be reconstructed after reopening the CLI. Unsubmitted drafts are not saved across CLI restarts.

A Claude process exits after two minutes idle; the next prompt or menu request resumes its saved native conversation. Each process has a server-managed 24-hour execution limit. If a sandbox disappears during a turn, Juiced restores saved output and reports the interruption without automatically resubmitting that turn. Session journals remain in the workspace until it is deleted. Native passthrough retains its renewable 90-second terminal lease, input batching, and raw Ctrl+C behavior. See [session recovery](docs/session-recovery.md) for the protocol and verification details.

For another machine, configure Cantelop's app integration profile or supply `CANTELOP_APP_SLUG` and `CANTELOP_INTEGRATION_TOKEN`, with `CANTELOP_EDGE_URL` for a local endpoint. The compiled CLI already carries its runtime identity. Keep app tokens private; they grant access to the app's workspaces. `CANTELOP_PROFILE` selects a configured profile.

## Bring Claude's changes back locally

Interactive Git sessions include the `juiced-local` MCP server. Ask Claude to
**publish its commits to your local checkout**, or to **bring its file edits back
as uncommitted changes**. The tools are `publish_commits` and `publish_snapshot`.
Juiced shows the pinned commit or snapshot, a path preview, and Claude's summary
in a local confirmation with **Deny** selected by default. Applying a publication
does not require GitHub, a tunnel, or a local listening server.

Commit publication fast-forwards a clean local source branch. Snapshot publication
preserves local staging and unrelated edits, and refuses overlapping edits or a
changed baseline commit. Successive snapshots use the last successfully published
snapshot as their shared baseline. Keep the local Juiced TUI connected to review
and apply requests; offers expire after five minutes. Claude receives an explicit
completion or failure result. See [local publication](docs/local-publication.md)
for the workflow, retained artifacts, and limitations.

Build and deploy the updated CLI and runtime together. Existing conversations
gain the tools when their native Claude process next starts; `/exit` followed by
`juiced claude` in the same tab restarts it while retaining the conversation.

## Inspect a workspace

```sh
juiced claude ls
juiced claude peek
juiced claude peek --changes-only
juiced claude peek src/
```

`ls` lists the immediate remote entries. `peek` compares immediate local and
remote entries side by side, including matching rows; `--changes-only` hides the
matches. A directory row summarizes its descendants, so you drill down one level
at a time by passing a path. Both commands read current Git-visible contents
through the SDK without synchronizing files, changing the real index, or starting
Claude, and neither needs Claude sign-in. Ignored untracked files are excluded;
`--include-ignored` requires an explicit path. A completed view exits 0 even when
it shows differences, while incomplete or excluded comparisons exit 2. See
[workspace inspection](docs/workspace-inspection.md) for the comparison symbols,
snapshot semantics, and limitations.

## Delete a workspace

```sh
juiced claude delete
juiced --workspace my-project claude delete
# Explicit confirmation for scripts:
juiced claude delete --yes
```

Deletion removes the entire remote workspace: its sessions, all project folders,
remote Git history, uncommitted edits, Claude login, and database data. It prints
the slug and canonical workspace ID, then asks you to type the slug; scripts must
pass `--yes`. An absent workspace is a no-op and is never created just to be
deleted. Local files, branches, and previously imported Git refs are kept, so
import any remote commits you want to keep before deleting. Remote purge is
asynchronous; a later launch creates a fresh workspace and requires Claude
sign-in again.

Deletion uses the SDK's `workspace.inspect()` and `workspace.delete()` with the
same app credentials as Juiced's other SDK operations, without shelling out to
Cantelop or needing account login. It needs an App Edge built with SDK 1.3.0 or
newer; local `cantelop dev` returns
`workspace_deletion_unavailable_in_local_dev`.

## Development

```sh
npm run check
npm test
npm run build
npm run build:runtime
node bin/juiced.mjs --help
```

After deployment, `npm link`, and `juiced claude login`, run `npm run test:live` to verify the installed command against Cantelop. It checks the remote Claude version and sends a small real prompt through stdin, asserting the exact streamed response and a successful exit. This uses your Claude subscription.

`npm run test:agent:live` separately verifies the headless handshake, two turns sharing conversation context, explicit denial followed by approval of a remote Write, and interruption followed by another successful turn. It uses the configured workspace and Claude subscription, then verifies and removes its uniquely named smoke-test file with an explicitly approved Bash command.

`npm run test:git:live` uses a uniquely named disposable Git project in
`JUICED_WORKSPACE` (default `default`), which must already be signed in to
Claude. It approves only exact fixture Bash commands, checks two concurrent
sessions sharing one checkout, imports and fast-forwards an agent commit, and
removes its remote fixture. It uses the Claude subscription.

`npm run test:delete:local` exercises workspace deletion against a loopback
fixture. `npm run test:delete:live` uses the configured app credentials to create
its own randomly named disposable workspaces, then checks missing-workspace
behavior, confirmation, deletion, database isolation on slug reuse, safe retries
against the old ID, and local file preservation. Its child CLI runs with an empty
PATH and no account credentials; it never starts Claude and cleans up its remote
fixtures.

`npm run test:inspection:local` covers `ls` and `peek`: the native runtime
handler and session activity, plus the built CLI through the real SDK Edge
adapter into a disposable platform fixture whose PATH contains Git only, with no
account credentials or Cantelop CLI. It verifies that fixture working trees and
Git directories keep their original bytes and metadata. These fixtures do not
deploy a hosted release. `node --import tsx scripts/probe-workspace-inspection.mjs`
regenerates the design evidence behind
[workspace inspection](docs/workspace-inspection.md) and is not part of the CLI.

Set `JUICED_DEBUG=1` to log session IDs, command types, request timing, and transport errors to stderr. Terminal input contents are excluded from these diagnostics.

To measure typing latency against the deployed app without submitting a model prompt:

```sh
npm run measure:latency -- --samples 10 --output /tmp/juiced-latency.json
```

This starts a fresh Claude terminal in the selected existing workspace, accepts its folder trust prompt, types synthetic text without pressing Enter, and stops the session. It records input acknowledgement and matching output timings with command IDs for server correlation; it excludes local batching and waiting behind earlier input. `--workspace` selects another workspace. The workspace must already have Claude sign-in and onboarding completed. No credentials or terminal output contents are written to the report.

The October 16 investigation correlated ten input samples with the compute host's durable receipt timestamps. Input visibility ranged from 430–1,639 ms and acknowledgement from 702–2,224 ms. Five slow samples spent 1,165–1,229 ms between sandbox binding and runtime admission, while the input handler itself took 0–1 ms at its millisecond clock resolution. A further 297–585 ms elapsed between handler settlement and the durable handled projection. Matching terminal output reached the event store in 16–26 ms. Cross-machine timestamp splits are approximate; client elapsed durations and the local reproductions do not depend on clock synchronization. See [the recorded measurements](diagnostics/terminal-latency-2026-10-16.json).

Two issues reproduce in the sibling Cantelop source: an admission wake consumed while the same sandbox's worker is busy does not survive worker release, leaving the next periodic sweep to pick it up; and reconciliation repeatedly revisits every settled command until the whole session becomes quiescent. With 100 settled commands, one pass makes 100 message reads, 300 execution-save calls, and 100 runtime status calls, plus fixed supervision calls. The fresh-delivery optimization also requires a group of exactly one execution, so it does not help an ongoing interactive session.

Run the source diagnostics with Go installed and the Cantelop checkout available:

```sh
npm run probe:reconciliation
# Or: node scripts/probe-cantelop-reconciliation.mjs /path/to/cantelop
```

These probes assert the observed behavior for the investigated platform revision. They use a temporary Go overlay and do not edit or deploy Cantelop. After platform fixes, their expectations should be updated. The recommended platform changes are to retain admission reruns per sandbox, prioritize new input and reply completion over old settled work, and supervise activity/output ownership per sandbox without repeatedly rewriting every finished command. A direct terminal WebSocket could then carry ordered bytes outside the durable command path. Switching the existing output stream to WebSocket alone would preserve the dispatch delay. Measured TCP connection time to the current compute host was 164–184 ms, so deployment locality remains relevant after the platform stalls are removed.

`build` produces the CLI with Cantelop's backend compiler transform; the sandbox implementation stays out of the local bundle. `build:runtime` produces the generated Edge API, sandbox runtime, and backend artifacts under `dist/cantelop`. `cantelop deploy` builds the deployable image using the SDK's Claude Dockerfile, including stock Claude Code, Python, Git, and ripgrep.

The tests exercise real subprocesses and PTYs plus the real SDK's request/SSE protocol against a local test transport. They cover input, resizing, cancellation, output replay, separate pipe stdout/stderr, exit codes, and terminal cleanup without a Cantelop deployment or model calls. PTY tests require Python 3 and macOS or Linux.

The local UI uses React and Ink. It communicates with stock Claude Code over its bidirectional JSONL control protocol: initialization, user messages, `can_use_tool` responses, and interruption. Cantelop carries commands and SSE notifications. Interactive Juiced sessions use pipes and a durable workspace journal on the server; native passthrough retains the Python PTY when needed. A supervised runtime activity keeps command intake responsive independently of the client connection.

Menus share a local renderer and command adapters. Settings pickers reuse a recent settings snapshot; nested data views, filtering, arrow keys, and back navigation use local state. Selecting the current value closes locally. Fresh data reads send one Claude control request while its process is live; confirmed changes wait for acknowledgment and persistence. To verify compatibility with an installed Claude binary without deploying or sending a model prompt, run `node --import tsx scripts/test-menus-local.mjs /path/to/claude`.

Live execution requires deploying the runtime and completing Claude sign-in. Local tests do not verify the hosted platform or your Claude subscription.

## Hosted verification

Workspace deletion was verified on October 19, 2026 against release v9
(`rel_b499d9481549a7f859bee02a37326346`) with SDK 1.3.0, alongside 87 local
tests, the type check, and both builds. The check covered read-only inspection
of a missing workspace without provisioning, a no-op deletion of an absent
workspace with an empty PATH, refusal to delete noninteractively without
`--yes`, deletion without a Cantelop CLI or account login, a fresh database on
slug reuse, a safe retry against the old canonical ID leaving its replacement
intact, and unchanged local files. Both disposable workspace IDs were archived
for asynchronous purge.
[Deletion evidence](diagnostics/workspace-delete-2026-10-19.json).

Git workspaces were verified on October 19, 2026 against release v8
(`rel_a8791118a314bb0d4dbc310041d12810`), alongside 59 local tests and both
builds, with no platform or SDK changes required. It transferred an unpublished
`HEAD` and staged snapshot without changing the local index, attached two
separate Claude sessions to one checkout, refused outbound checkout replacement
while they were active, imported a remote commit with its original identity,
refused a fast-forward over dirty local work and then advanced the clean source
branch, and completed an outbound sync once both sessions closed.
[Git evidence](diagnostics/git-release-2026-10-19.json).

Workspace inspection (`ls` and `peek`) is verified locally only, with 99 passing
tests on October 19, 2026 and no hosted deployment. See
[the inspection evidence](diagnostics/workspace-inspection-2026-10-19.json).

Release v4 (`rel_0760c39bd457205a9bdbf5a8f1a9d56c`) was activated on October 16,
2026 with published SDK 1.2.0. Signed and notarized Cantelop CLI 0.16.1
(`edb6351c0eeb`) was published, installed through Homebrew, and its macOS signature
verified. The runtime runs platform commit `edb6351c0eebc4350b1214000b376ddf6ea125a8`;
Cloudflare was deployed from `05d01a27b8dc77496f0dc90904491d285b93f4f6`.

Historical file-sync qualification: hosted writes were enabled against the real
JuiceFS data mount and a disposable loopback NFS export. That check covered both transfer directions,
stale versions, competing clients, NFS write/rename/delete/type changes during
upload, interruption cleanup, and sibling confinement. Qualification exposed a
trash-retained hard link from file publication; new files now use atomic
no-overwrite rename through pinned directory descriptors. Genuine hard links
remain rejected. Concurrency with arbitrary filesystem writers remains optimistic.

The installed `juiced claude` uploaded a disposable local README, had real Claude
read its unique token from the remote project directory, streamed the exact reply,
and exited with code 0. The live local-TUI test separately approved one remote
Write and verified the resulting file locally through sync. Both tests removed
their remote fixture files through synchronized deletion and reused the existing
`default` workspace login without relocating credentials. Automatic workspace
selection is covered by local tests; each newly selected workspace needs its own
Claude login. [Release evidence](diagnostics/sync-release-2026-10-16.json).

Release v3 (`rel_4f206ba65af1e78dac06408895053726`) earlier verified SDK 1.1.0 and
CLI 0.16.0 against the public sync download route, with uploads deliberately
disabled before storage qualification.

The local Juiced TUI was verified against active release v2 (`rel_3af3dee9134a99e9635b0d103c89d67c`) on October 16, 2026. The installed `juiced claude` rendered a streamed answer, answered an `AskUserQuestion` dialog, interrupted generation, accepted another turn, and exited with code 0. The headless live test verified persistent conversation context, denial and approval of a Write, remote file verification and cleanup, interruption without duplicate output, and another successful turn. Native piped execution also passed. Offline renderer tests verify that keystrokes and multiline paste remain local even while the connection is stalled, and that pasted text cannot approve an action.

Verified against Cantelop on October 16, 2026, using app `juiced` and active release v1 (`rel_ac265686e609d480b2dca6d1cd8cd04b`). The installed `juiced` command returned Claude Code `2.1.259` in both pipe and PTY modes, passed the real prompt smoke test, and displayed the native interactive UI. Typing a prompt through the PTY returned `JUICED_INTERACTIVE_OK`; `/exit` returned exit code 0 and restored the local terminal. A fresh session retained Claude sign-in and completed onboarding, with native folder trust prompts preserved.
