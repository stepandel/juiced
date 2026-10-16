# Juiced

Run the real Claude Code CLI in a Cantelop session, attached to your local terminal:

```sh
juiced claude
```

Each invocation starts a fresh session in a persistent remote workspace. Claude's interface, colors, keyboard input, permission prompts, terminal resizing, and exit status pass through. Files and Claude authentication stay in the remote workspace between sessions. Your local project is not uploaded.

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

The first interactive launch also runs Claude's native onboarding. Complete its theme, subscription login, and safety screens once; that setup persists in the workspace. Claude retains its own folder trust and permission prompts.

## Use

Arguments after `claude` are forwarded unchanged:

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

The default workspace slug is `default`. Workspaces share neither files nor Claude login. Sessions within the same workspace share its files, so concurrent sessions can edit the same files.

Typing uses a fixed 8 ms batching window. Keys continue accumulating while a request is in flight and travel together in the next request, reducing the backlog from waiting for each keystroke separately. Enter, Escape, backspace, and control keys flush pending text and keep their own input boundaries. Pasted bytes and EOF retain their order, with bounded buffering for large inputs. Batching reduces accumulated delay; the underlying HTTP request latency still affects the first key.

Ctrl-C reaches Claude as it would locally. Closing the session restores your terminal and releases the sandbox. If the client disappears or loses connectivity, the remote process is cancelled when its renewable 90-second terminal lease expires; Cantelop can then reclaim the idle sandbox. The CLI retries interrupted output streams up to three times using their last cursor. It never replays keyboard input or silently starts another Claude process.

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

The transport uses Cantelop commands for input and SSE for output. Interactive sessions use a Python PTY; piped sessions use separate stdin/stdout/stderr pipes. A supervised runtime activity keeps command intake responsive and renews its deadline while the client is connected.

Live execution requires deploying the runtime and completing Claude sign-in. Local tests do not verify the hosted platform or your Claude subscription.

## Hosted verification

Verified against Cantelop on October 16, 2026, using app `juiced` and active release v1 (`rel_ac265686e609d480b2dca6d1cd8cd04b`). The installed `juiced` command returned Claude Code `2.1.259` in both pipe and PTY modes, passed the real prompt smoke test, and displayed the native interactive UI. Typing a prompt through the PTY returned `JUICED_INTERACTIVE_OK`; `/exit` returned exit code 0 and restored the local terminal. A fresh session retained Claude sign-in and completed onboarding, with native folder trust prompts preserved.
