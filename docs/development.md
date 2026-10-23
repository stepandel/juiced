# Development

## Build and test

```sh
npm install
npm run check
npm test
npm run build
npm run build:runtime
node bin/juiced.mjs --help
```

`build` produces the CLI with Cantelop's backend compiler transform; the sandbox
implementation stays out of the local bundle. `build:runtime` produces the
generated Edge API, sandbox runtime, and backend artifacts under `dist/cantelop`.
`cantelop deploy` builds the deployable image from the root `Dockerfile`,
including Claude Code, Python, Git, and ripgrep.

The tests exercise real subprocesses and PTYs plus the real SDK's request/SSE
protocol against a local test transport. They cover input, resizing,
cancellation, output replay, separate pipe stdout/stderr, exit codes, and
terminal cleanup without a Cantelop deployment or model calls. PTY tests require
Python 3 and macOS or Linux.

Set `JUICED_DEBUG=1` to log session IDs, command types, request timing, and
transport errors to stderr. Terminal input contents are excluded.

## Local fixtures

- `npm run test:delete:local` exercises workspace deletion against a loopback
  fixture.
- `npm run test:inspection:local` covers `ls` and `peek`: the native runtime
  handler and session activity, plus the built CLI through the real SDK Edge
  adapter into a disposable platform fixture whose PATH contains Git only, with
  no account credentials or Cantelop CLI. It verifies that fixture working trees
  and Git directories keep their original bytes and metadata.
  `node --import tsx scripts/probe-workspace-inspection.mjs` regenerates the
  design evidence behind [workspace inspection](workspace-inspection.md).
- `node --import tsx scripts/test-menus-local.mjs /path/to/claude` verifies menu
  compatibility with an installed Claude binary without deploying or sending a
  model prompt.

## Live tests

Live tests need a configured [Juiced service and Fleet](fleet-sdk-migration.md), a Juiced login, `npm link`, and
`juiced claude login`. They use your Claude subscription.

- `npm run test:live` checks the remote Claude version and sends a small real
  prompt through stdin, asserting the exact streamed response and a successful
  exit.
- `npm run test:agent:live` verifies the headless handshake, two turns sharing
  conversation context, denial followed by approval of a remote Write, and
  interruption followed by another successful turn. It removes its smoke-test
  file with an explicitly approved Bash command.
- `npm run test:git:live` uses a uniquely named disposable Git project in
  `JUICED_WORKSPACE` (default `default`), which must already be signed in to
  Claude. It approves only exact fixture Bash commands, checks two concurrent
  sessions sharing one checkout, imports and fast-forwards an agent commit, and
  removes its remote fixture.
- `npm run test:delete:live` creates its own randomly named disposable
  workspaces, then checks missing-workspace behavior, confirmation, deletion,
  database isolation on slug reuse, safe retries against the old ID, and local
  file preservation. Its child CLI runs with an empty PATH and no account
  credentials; it never starts Claude.

Local tests do not verify the hosted platform or your Claude subscription.

## Latency measurement

To measure typing latency against the deployed app without submitting a model
prompt:

```sh
npm run measure:latency -- --samples 10 --output /tmp/juiced-latency.json
```

This starts a fresh Claude terminal in the selected existing workspace, accepts
its folder trust prompt, types synthetic text without pressing Enter, and stops
the session. It records input acknowledgement and matching output timings with
command IDs for server correlation. `--workspace` selects another workspace,
which must already have Claude sign-in and onboarding completed. No credentials
or terminal output contents are written to the report.

`npm run probe:reconciliation` (or
`node scripts/probe-cantelop-reconciliation.mjs /path/to/cantelop`) runs the
platform source diagnostics. It needs Go and a Cantelop checkout. See
[diagnostics](../diagnostics/README.md) for the recorded findings.

## Architecture

The local UI uses React and Ink. It communicates with stock Claude Code over its
bidirectional JSONL control protocol: initialization, user messages,
`can_use_tool` responses, and interruption. Cantelop carries commands and SSE
notifications. Interactive sessions use pipes and a durable workspace journal on
the server; native passthrough retains the Python PTY when needed. A supervised
runtime activity keeps command intake responsive independently of the client
connection.

Submitted prompts and controls use ordered requests with stable delivery
identities. Each complete JSON frame is acknowledged after native stdin handoff;
retries reuse its identity. Responses and permission requests stream
independently. Network latency affects submission and response arrival, but
cannot delay local typing. Prompts are limited to 512 KiB, pending input to
1 MiB, and encoded interactive frames to 768 KiB. Native stdin writes remain
fragmented to 16 KiB.

No client heartbeat owns an interactive session's lifetime. The TUI recovers
missed output from the workspace journal even when Cantelop's replay cursor has
expired. Native passthrough retains its renewable 90-second terminal lease,
input batching, and raw Ctrl+C behavior.

Menus share a local renderer and command adapters. Settings pickers reuse a
recent settings snapshot; nested data views, filtering, arrow keys, and back
navigation use local state. Fresh data reads send one Claude control request
while its process is live; confirmed changes wait for acknowledgment and
persistence.

The [multitenancy architecture](multitenancy.md) and
[implementation plan](multitenancy-implementation.md) describe the managed
service design.
