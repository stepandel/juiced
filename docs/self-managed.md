# Self-managed deployment

Managed mode is the default: you sign in to a Juiced account and Juiced runs the
Cantelop infrastructure. To run Juiced against your own Cantelop app instead, set
`JUICED_MODE=self-managed` or pass `--self-managed` before commands.

## Set up

Running Juiced needs Node.js 22+ and configured Cantelop app credentials. The
[Cantelop CLI](https://cantelop.com/docs) and Docker are deployment tools used for
the initial runtime setup.

From the repository root:

```sh
npm install
npm run build
cantelop login
cantelop deploy
npm link
```

The app is named `juiced` in `src/cantelop.ts`. If you need another deployment
name, change that literal before building and deploying. Build the CLI and deploy
the runtime from the same source: Cantelop checks their runtime identities.
Deployment saves app credentials in your local Cantelop integration profile,
which Juiced reads automatically.

For another machine, configure Cantelop's app integration profile or supply
`CANTELOP_APP_SLUG` and `CANTELOP_INTEGRATION_TOKEN`, with `CANTELOP_EDGE_URL`
for a local endpoint. The compiled CLI already carries its runtime identity.
Keep app tokens private; they grant access to the app's workspaces.
`CANTELOP_PROFILE` selects a configured profile.

## Claude Code version

The root `Dockerfile` pins Claude Code independently of the Cantelop SDK's
bundled image. Model choices and alias targets come from that remote CLI;
`/model` refreshes its catalog whenever the picker opens. To update Claude Code,
bump `CLAUDE_CODE_VERSION` in the Dockerfile, run the model-free compatibility
check in [Local command menus](local-command-menus.md), then rebuild and deploy.
Existing processes keep their loaded CLI: use `/exit` and reopen the conversation
after deployment to load the new version. Check the deployed version with
`juiced claude --version`.

## Upgrading

Build and deploy the CLI and runtime together. Existing conversations pick up new
runtime features, such as the `juiced-local` MCP tools, when their native Claude
process next starts; `/exit` followed by `juiced claude` in the same tab restarts
it while retaining the conversation.

Feature requirements:

- GitHub configuration and `juiced env` need SDK 1.4.0 and the platform
  environment API. Deploy the platform and Juiced runtime once; later token
  rotations are configuration updates.
- Workspace deletion needs an App Edge built with SDK 1.3.0 or newer. Local
  `cantelop dev` returns `workspace_deletion_unavailable_in_local_dev`.

## Environment variables and secrets

```sh
printf '%s' "$GH_TOKEN" | juiced env set GH_TOKEN --stdin
juiced env unset GH_TOKEN
```

Values are Cantelop secrets by default. `--plain` selects an ordinary variable
that the deployed app declares. Input is read from stdin, with one trailing
newline removed; values never appear in command arguments or Juiced output. The
command uses the SDK and the existing app integration credential. It needs
neither the Cantelop CLI nor Claude sign-in, and waits until Edge and compute
configuration have applied the update. Changes require no deployment.

Configuration is app-wide, across all of its workspaces. New remote processes
receive the updated value; already-running processes keep their environment
until they exit. Resuming a conversation after `/exit` reloads it with the
updated configuration.
