# Juiced

Git repositories now use explicit Git transfers. See [Git workspaces](docs/git-workspaces.md) for snapshot transfer, importing commits, optional fast-forwarding, and migration from file sync. The continuous-sync description below applies to non-Git directories.

Run the real Claude Code CLI in a Cantelop session, attached to your local terminal:

```sh
juiced claude
```

Interactive invocations open the **Juiced TUI on your machine**, connected to a headless Claude Code process on Cantelop. Typing, cursor movement, multiline editing, and pasting happen locally. Only submitted prompts, permission answers, and interrupts cross the network. Claude's agent loop, tools, files, and authentication stay in the persistent remote workspace. Your local project is not uploaded.

The local interface streams Claude's responses, shows tool activity, and asks before actions that Claude requires permission to run. Each invocation starts a fresh remote process and conversation; turns within that invocation share the same Claude process and context. Piped commands and explicit `-p`, `--help`, and `--version` invocations retain the native CLI passthrough.

## Set up

You need Node.js 22+, the [Cantelop CLI](https://cantelop.com/docs), and Docker for the initial runtime deployment.

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
juiced login
juiced claude
```

`juiced login` prints Claude's sign-in URL and asks for the returned authorization code. The native Claude login runs inside Cantelop; credentials persist in the workspace. Interactive `juiced claude` also starts this login flow when needed. Piped commands require an existing login.

`juiced claude --version` and `juiced claude --help` work before Claude sign-in and can verify connectivity to the deployed runtime.

The local UI uses Claude's programmatic mode in the remote workspace you have chosen. It does not run native terminal onboarding or show a remote folder-trust dialog. Claude's own tool permission checks remain active; permission requests appear in Juiced with **Deny** selected by default. Permission grants apply once, without changing stored permission rules. `AskUserQuestion` prompts accept a typed answer or an option number.

## Use

Arguments after `claude` configure the remote Claude process. Interactive launches add the JSON transport flags needed by the local UI. Explicit print/introspection/output-format invocations use native passthrough:

```sh
juiced claude --model sonnet
juiced claude --help
juiced claude -p "Explain the repository in this workspace"
cat prompt.txt | juiced claude -p
juiced claude -p "Summarize the project" > summary.txt
```

Select another persistent workspace with an option **before** the command:

```sh
juiced --workspace my-project login
juiced --workspace my-project claude
# Or choose a default for this shell:
export JUICED_WORKSPACE=my-project
```

The current directory selects a persistent workspace automatically. The slug is
its folder name plus a stable hash of its resolved absolute path, so two projects
with the same folder name remain separate. `--workspace` or `JUICED_WORKSPACE`
overrides that selection. Workspaces share neither files nor Claude login.

Juiced synchronizes the current directory into `/workspace/<folder-name>` and
starts Claude there after initial two-way reconciliation succeeds. It keeps
syncing while the command runs, flushes before each interactive prompt or tool
approval, and flushes once more on normal exit. Claude's HOME and account state
remain at `/workspace`, including `.claude` and `.local`; sibling folders never
enter the project's sync tree. Each project workspace needs its own Claude login.

`.git`, `.cantelop`, `node_modules`, `.env*`, temporary sync files, `dist`, and
`coverage` are excluded. Divergent edits preserve both copies and stop the agent
with a conflict error. Resolve both copies before restarting. One local directory
can have one active sync handle. Sync runs only while Juiced is running.

Juiced uses the published `@cantelop/sdk` 1.2.0 release.

Automatic sync needs the matching platform, generated App Edge, SDK, and native
Cantelop helper. Hosted writes are operator-gated: Juiced refuses to start an
agent when uploads are disabled, including for empty directories. The current
deployment enables writes after live JuiceFS/NFS qualification. An existing login is retained in its original
workspace; pass `--workspace default` to reuse the previous default workspace.

In the local UI:

- **Enter** submits the complete prompt when Claude is ready.
- **Alt+Enter**, **Shift+Enter** in terminals that support it, or **`\` then Enter** inserts a newline. Multiline paste stays in the editor until you submit.
- Arrow keys, Home/End, backspace/delete, Ctrl+A/E, Ctrl+U/K/W edit the local draft, including Unicode characters.
- **Esc** or **Ctrl+C** during a turn interrupts Claude. You can draft your next prompt while it works; Enter keeps that draft until the current turn finishes.
- **Ctrl+C** while idle clears the draft, then exits if it is empty. **Ctrl+D** with an empty draft, **`/exit`**, and **`/quit`** disconnect and stop the remote process.
- **`/`** previews available commands with descriptions and argument hints. Keep typing to filter, use **↑/↓** to select, **Tab** to complete before adding arguments, and **Enter** to run the selection. **Esc** closes the menu without changing your draft.
- **`/help`** shows the local shortcuts. Suggestions include Juiced's local commands and commands reported by the remote Claude session, including its project skills and custom commands. Commands requiring Claude's native terminal menus are unavailable in this interface.

Submitted prompts and controls use ordered `session.dispatch()` calls. The stream carries responses and permission requests independently; the client does not wait for a runtime reply before submitting the next JSON fragment. Network latency still affects submission and response arrival, but cannot delay local typing. Prompts are limited to 512 KiB, pending input to 1 MiB, and transport fragments to 16 KiB.

Closing the session restores your terminal and releases the sandbox. If the client disappears or loses connectivity, the remote process is cancelled when its renewable 90-second terminal lease expires; Cantelop can then reclaim the idle sandbox. The CLI retries interrupted output streams up to three times using their last cursor. It retains partial JSON frames across reconnects and never automatically replays a prompt or starts a replacement Claude process. Native passthrough keeps its existing terminal input batching and raw Ctrl+C behavior.

For another machine, configure Cantelop's app integration profile or supply `CANTELOP_APP_SLUG` and `CANTELOP_INTEGRATION_TOKEN`, with `CANTELOP_EDGE_URL` for a local endpoint. The compiled CLI already carries its runtime identity. Keep app tokens private; they grant access to the app's workspaces. `CANTELOP_PROFILE` selects a configured profile.

## Development

```sh
npm run check
npm test
npm run build
npm run build:runtime
node bin/juiced.mjs --help
```

After deployment, `npm link`, and `juiced login`, run `npm run test:live` to verify the installed command against Cantelop. It checks the remote Claude version and sends a small real prompt through stdin, asserting the exact streamed response and a successful exit. This uses your Claude subscription.

`npm run test:agent:live` separately verifies the headless handshake, two turns sharing conversation context, explicit denial followed by approval of a remote Write, and interruption followed by another successful turn. It uses the configured workspace and Claude subscription, then verifies and removes its uniquely named smoke-test file with an explicitly approved Bash command.

`npm run test:sync:live` uses a disposable project folder in a signed-in workspace
(`JUICED_WORKSPACE`, default `default`). It uploads a README, asks real Claude to
read it and write one explicitly approved fixture, verifies the edit locally,
and removes both remote fixture files through sync.

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

The local UI uses React and Ink. It communicates with stock Claude Code over its bidirectional JSONL control protocol: initialization, user messages, `can_use_tool` responses, and interruption. Cantelop carries JSON bytes over commands and SSE. Interactive Juiced sessions use pipes on the server; native passthrough retains the Python PTY when needed. A supervised runtime activity keeps command intake responsive and renews its deadline while the client is connected. Dispatch delivery errors are reported on SSE.

Live execution requires deploying the runtime and completing Claude sign-in. Local tests do not verify the hosted platform or your Claude subscription.

## Hosted verification

Release v4 (`rel_0760c39bd457205a9bdbf5a8f1a9d56c`) was activated on October 16,
2026 with published SDK 1.2.0. Signed and notarized Cantelop CLI 0.16.1
(`edb6351c0eeb`) was published, installed through Homebrew, and its macOS signature
verified. The runtime runs platform commit `edb6351c0eebc4350b1214000b376ddf6ea125a8`;
Cloudflare was deployed from `05d01a27b8dc77496f0dc90904491d285b93f4f6`.

Hosted writes are enabled after qualification against the real JuiceFS data mount
and a disposable loopback NFS export. That check covered both transfer directions,
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
