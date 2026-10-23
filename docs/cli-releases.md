# CLI releases

Juiced can be installed using `curl -fsSL https://juiced.codes/install.sh | sh`.
This becomes available after deploying the website's `service/public/install.sh` and
publishing the first GitHub Release. The website stays in private preview until
the managed service is qualified. Installing the CLI does not activate accounts.
No npm publication is needed; npm is used only to build the archives.

## Build and verify

```sh
npm ci --ignore-scripts
npm run build
npm run build:runtime
npm run build:release
npm run test:installer -- dist/releases/juiced-darwin-arm64.tar.gz
```

Use the archive matching the build machine. Build on Node 24 and a native macOS
or Linux x64/arm64 host. Packaging retains the lockfile's production dependency
versions and integrity checks and excludes the private service workspace and
development dependencies. It downloads
the build host's Node version from nodejs.org, checks the official SHA-256 digest,
and includes the portable executable and Node's license. Dependency licenses
remain in their package directories. `release.json` records the version, Node
version, OS and architecture. Node's OS requirements apply: macOS 13.5+ or Linux
with glibc 2.28+; Alpine/musl and Windows are not supported by this installer.
See [Node 24 platform requirements](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list).

`dist/releases/` contains the host's `juiced-<os>-<arch>.tar.gz` and its `.sha256`
entry. The packaging check runs real offline help/version. The installer tests
exercise a piped shell, version selection, paths with spaces, updates, failed
downloads and checksum failures. Passing an archive additionally installs and
runs that archive with Node and npm absent from PATH.

## Publish

1. Set the CLI version in `package.json`, `package-lock.json` and the source
   default in `src/version.ts`. Commit the source and qualify its managed runtime.
2. Every push to `main` prepares immutable archives in `.github/workflows/release.yml`.
   Push a matching `v<version>` tag to publish them. The tag reuses a successful
   main run only for the exact source commit, with all four unexpired archives
   and its qualification receipt. Otherwise it builds fresh artifacts.
   The workflow checks and packages Linux x64/arm64 and macOS Intel/Apple Silicon on native runners.
   A manual workflow run builds artifacts without creating a release.
   Packaging runs independently of tests. Intel macOS runs the same complete CLI
   suite in four native shards, serially within each shard, to avoid contention
   between compiler and filesystem fixtures. Every platform still installs its
   actual archive without Node/npm on PATH. Dependency downloads use npm caches.
3. All four jobs must pass, including installation of their actual archives.
   The workflow creates a **draft** GitHub Release with the four archives,
   `SHA256SUMS` and a copy of `install.sh`. Review and publish the draft when
   service admission and runtime compatibility are ready. Mark prereleases
   appropriately; `latest` installs the latest stable GitHub Release.
4. Deploy the website from the committed source so Vercel serves
   `service/public/install.sh` at `/install.sh`. Then check the public installation from
   a clean user directory before advertising it on the homepage.

## Resumable production release

Use the committed version bump after it reaches `main`. The release command
requires successful main service CI as well as the native archive qualification.
It never creates a version bump or merges source for you.

```sh
# One-time operator setup: gh auth login, vercel login, and juiced login.
export CANTELOP_BIN=/path/to/cantelop  # Fleet-aware CLI >=0.17.1
export CANTELOP_INTEGRATION_CONFIG=/secure/juiced-integration.json
# Supply CANTELOP_FLEET_TOKEN from your secret manager: short-lived deployment
# principal with packages:write and installations:read/write, for this Fleet.
chmod 600 "$CANTELOP_INTEGRATION_CONFIG"

npm run release -- plan     # Read-only stage list; no credentials required.
npm run release -- prepare  # Download qualified CLI archives + runtime dry-run concurrently.
npm run release -- ship     # Prepare if needed, then publish and promote.
```

The private integration file must include matching `api` and `worker` Fleet
bindings with distinct unexpired service principals. The deployment principal
stays in the process environment. The command does not obtain owner credentials
or create a long-lived deployment principal. Revoke the short-lived principal
through the secret manager after shipping. Optional overrides:
`JUICED_RELEASE_REPOSITORY`, `VERCEL_PROJECT`, `VERCEL_SCOPE`, `JUICED_SERVICE_URL`.

Preparation waits for the exact main commit's background archive build and runs
`cantelop deploy --dry-run` concurrently. Archives include commit and runtime
identity in `release.json`; every checksum, version, platform and runtime must
match before promotion. Cached archives expire after seven days. Failed native
tests never produce reusable qualification, and pull-request/fork artifacts
cannot satisfy preparation. A tag can rebuild expired artifacts normally.
The automated command requires a successful main preparation run; if all of
that commit's artifacts have expired, use a fresh main commit or the manual
tag-and-qualify path above.

Shipping publishes the matching CLI assets first, deploys the Fleet package,
qualifies an isolated canary with production resource limits, exports separate
API/worker bindings to Vercel, deploys production, resumes the CLI-owned instance
rollout, and calls the new deployment's authenticated `/api/release` endpoint.
It then verifies health, installs the public CLI into an isolated directory,
runs remote `claude --version` through the signed-in account, and deletes that
test workspace. It never sends a model prompt. Use a dedicated signed-in canary
account/configuration for unattended operators.

The Fleet CLI currently publishes the package and upgrades existing instances
in the same command. Its dry-run prepares/caches local build work; it does not
prepublish an inactive Fleet package. Provider runtime preparation therefore
remains on the shipping path. CLI assets must be public before that command,
and the service binding must follow it promptly. Full preparation followed by
an atomic Fleet promotion needs a separate platform/CLI capability.

Each completed stage records its duration and completion in
`dist/release/<version>-<commit>/state.json`. Rerun the same command from the same
source commit to resume; completed deployments and canaries are not repeated.
All preparation branches settle before releasing the process lock. A failed
stage stays incomplete. Private integration exports, promotion tokens, command
logs and receipts have restricted permissions. `--state /private/path` chooses
another directory outside the source checkout. Docker and Vercel exclude the
default state directory. Remove this private state after retaining a sanitized
release receipt; never upload it as an artifact.

If Cantelop failed after publishing a package, inspect the private deployment
log and resume that immutable package explicitly:

```sh
npm run release -- ship --state /private/previous-release --resume-package pkg_...
```

Never recreate or overwrite an existing immutable version. An interrupted
process may leave a `lock` file; remove it only after confirming that process
has stopped. Run only one production release operator at a time: the local
lock coordinates a state directory, not separate machines. Keep the original
state and promotion-token file when resuming a deployed release.

Promotion records a monotonically increasing generation and the exact
package/runtime pair in Postgres. New workers and bootstrap requests check this
fence; superseded deployments stop claiming provisioning work or perpetuating
queue wake-ups. Promotion resets pending observation delays and queues every
existing active installation immediately, without waiting for a user's next
command. Running leases, deletion retries, entitlement and policy fences remain
intact. Repeating the endpoint is idempotent and recovers a failed queue publish;
an older generation cannot reactivate itself. A rollback uses a newer generation
with the selected older package/runtime, rather than reusing an old promotion.

The additive migration leaves generation checking inactive until the first
promotion. Runtime database connections declare their generation in
`application_name`, which [PgBouncer tracks across transactions](https://www.pgbouncer.org/config#track_extra_parameters); provider connection options
are preserved. Row policies
on jobs and installations prevent restricted roles in pre-fence deployments
from claiming or overwriting current rollout work, even without application
guards. Use the restricted API/worker database roles, never an owner/bypass-RLS
connection, in production. Manual service deployments must also set the matching
`JUICED_RELEASE_GENERATION` and call `/api/release` with their private
`JUICED_RELEASE_TOKEN`; a deployment does not silently promote itself at startup.
Those values are set automatically by the release command. Queue callbacks from
old Vercel deployments can still arrive, but guarded deployments acknowledge
them without scheduling more work.

### Release candidates

Use a SemVer suffix such as `0.2.0-rc.4` for all CLI version fields and the matching
`v0.2.0-rc.4` tag. The workflow marks the draft as a prerelease automatically.
Publish it with the prerelease flag retained and without marking it latest.
Before `/install.sh` is deployed to the website, install the candidate directly:

```sh
curl -fsSL https://github.com/stepandel/juiced/releases/download/v0.2.0-rc.4/install.sh | sh -s -- 0.2.0-rc.4
```

An RC requires an explicit version; GitHub's stable `latest` endpoint excludes
prereleases. For managed-account testing, deploy the service's prerelease-aware
version check and set `JUICED_MINIMUM_CLI=0.2.0-rc.4` alongside the matching
qualified package/runtime IDs. A stable minimum of `0.2.0` correctly excludes
`0.2.0-rc.4`. Publishing the CLI does not activate or deploy account infrastructure.

The installer resolves GitHub's latest release to a specific version before
downloading its checksum manifest and archive. Checksums detect corrupt or
mismatched downloads; they are fetched over HTTPS from the same release and are
not an independent signature. Archives retain Node's upstream signing; this
workflow does not sign or notarize Juiced itself. Never replace published assets;
issue a new version instead.

GitHub references: [release download URLs](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
and [native runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Updates, rollback and removal

Installer-owned releases check for updates before managed commands, install the
service's recommended CLI automatically, then restart with the original arguments
and stdin. Help, version and logout skip this check; source/package-manager installations keep their existing installation method.
`juiced update` checks explicitly without signing in. Checks time out after five
seconds; an unavailable update check warns and lets a compatible CLI continue.
Downloads retain checksum verification and atomic activation, and concurrent
terminals share one update lock. Updates do not replace running CLI processes.

The service advertises `JUICED_CLI_VERSION` through public `/v1/config`. It defaults
to the source CLI version and must match the approved package/runtime; it must be
at least `JUICED_MINIMUM_CLI`. Publish all release assets first, then promote the
matching service package/runtime, recommended CLI and minimum together. This keeps
clients from automatically installing a newer GitHub release before its runtime
is approved. Services without this field fall back to GitHub's latest stable
release. Pin `JUICED_CLI_VERSION` explicitly in production so source version bumps
cannot promote an unqualified CLI. Never point the service at an unpublished release.

`cli_upgrade_required` and `session_runtime_mismatch` trigger one required update
attempt. A mismatch during bootstrap can restart automatically; after command
execution starts, an update asks the user to rerun the command so operations and
piped secrets are not replayed. Repeated mismatches, missing matching releases and
failed updates give the manual installer command without looping. Source installs
receive rebuild instructions. Existing binaries need a one-time manual install of
an updater-enabled release; updates cannot add this behavior to a running old CLI.

Rerun the installation command to update, or use `sh -s -- <version>` to install
an older compatible version. `JUICED_VERSION` also accepts a version; an argument
takes precedence. The installer checks the new CLI before atomically replacing
its command symlink. Failed downloads and checksums leave the current command
intact. It refuses to replace a command from another installation method.

Each install keeps its own release directory under `~/.local/share/juiced/releases`
(or `JUICED_INSTALL_DIR/releases`). Older directories can be deleted once no
running sessions use them. To remove the default installation:

```sh
rm "$HOME/.local/bin/juiced"
rm -rf "$HOME/.local/share/juiced"
```

With `XDG_DATA_HOME` set, the default data directory is `$XDG_DATA_HOME/juiced`.
Removal leaves account credentials and project/session metadata intact. Run
`juiced logout` first to revoke the device if desired. Shell configuration is
never modified automatically.
