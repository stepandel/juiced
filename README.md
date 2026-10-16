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

`build` produces the CLI with Cantelop's backend compiler transform; the sandbox implementation stays out of the local bundle. `build:runtime` produces the generated Edge API, sandbox runtime, and backend artifacts under `dist/cantelop`. `cantelop deploy` builds the deployable image using the SDK's Claude Dockerfile, including stock Claude Code, Python, Git, and ripgrep.

The tests exercise real subprocesses and PTYs plus the real SDK's request/SSE protocol against a local test transport. They cover input, resizing, cancellation, output replay, separate pipe stdout/stderr, exit codes, and terminal cleanup without a Cantelop deployment or model calls. PTY tests require Python 3 and macOS or Linux.

The transport uses Cantelop commands for input and SSE for output. Interactive sessions use a Python PTY; piped sessions use separate stdin/stdout/stderr pipes. A supervised runtime activity keeps command intake responsive and renews its deadline while the client is connected.

Live execution requires deploying the runtime and completing Claude sign-in. Local tests do not verify the hosted platform or your Claude subscription.
