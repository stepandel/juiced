# CLI releases

Juiced can be installed using `curl -fsSL https://juiced.codes/install.sh | sh`.
This becomes available after deploying the website's `public/install.sh` and
publishing the first GitHub Release. The website stays in private preview until
the managed service is qualified. Installing the CLI does not activate accounts.
No npm publication is needed; npm is used only to build the archives.

## Build and verify

```sh
npm ci --ignore-scripts
npm run build
npm run build:release
npm run test:installer -- dist/releases/juiced-darwin-arm64.tar.gz
```

Use the archive matching the build machine. Build on Node 24 and a native macOS
or Linux x64/arm64 host. Packaging retains the lockfile's production dependency
versions and integrity checks, includes optional native credential storage, and
excludes the private service workspace and development dependencies. It downloads
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
2. Push a matching `v<version>` tag. `.github/workflows/release.yml` checks and
   packages Linux x64/arm64 and macOS Intel/Apple Silicon on native runners.
   A manual workflow run builds artifacts without creating a release.
3. All four jobs must pass, including installation of their actual archives.
   The workflow creates a **draft** GitHub Release with the four archives,
   `SHA256SUMS` and a copy of `install.sh`. Review and publish the draft when
   service admission and runtime compatibility are ready. Mark prereleases
   appropriately; `latest` installs the latest stable GitHub Release.
4. Deploy the website from the committed source so Vercel serves
   `public/install.sh` at `/install.sh`. Then check the public installation from
   a clean user directory before advertising it on the homepage.

### Release candidates

Use a SemVer suffix such as `0.2.0-rc.3` for all CLI version fields and the matching
`v0.2.0-rc.3` tag. The workflow marks the draft as a prerelease automatically.
Publish it with the prerelease flag retained and without marking it latest.
Before `/install.sh` is deployed to the website, install the candidate directly:

```sh
curl -fsSL https://github.com/stepandel/juiced/releases/download/v0.2.0-rc.3/install.sh | sh -s -- 0.2.0-rc.3
```

An RC requires an explicit version; GitHub's stable `latest` endpoint excludes
prereleases. For managed-account testing, deploy the service's prerelease-aware
version check and set `JUICED_MINIMUM_CLI=0.2.0-rc.3` alongside the matching
qualified package/runtime IDs. A stable minimum of `0.2.0` correctly excludes
`0.2.0-rc.3`. Publishing the CLI does not activate or deploy account infrastructure.

The installer resolves GitHub's latest release to a specific version before
downloading its checksum manifest and archive. Checksums detect corrupt or
mismatched downloads; they are fetched over HTTPS from the same release and are
not an independent signature. Archives retain Node's upstream signing; this
workflow does not sign or notarize Juiced itself. Never replace published assets;
issue a new version instead.

GitHub references: [release download URLs](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
and [native runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Updates, rollback and removal

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
