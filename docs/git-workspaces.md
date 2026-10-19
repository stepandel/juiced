# Git workspaces

Run `juiced claude` from a Git repository to initialize a persistent remote
checkout from the exact local `HEAD`, including unpublished commits and their
history. Later invocations start new Claude sessions in that same checkout.
The canonical local path still selects the workspace; `--workspace SLUG` before
`claude` overrides it. Running from a subdirectory transfers the whole repository
and starts Claude in the corresponding remote subdirectory. Linked local Git
worktrees are supported.

Git repositories use explicit transfers. Local edits and remote edits do not
automatically appear on the other side. Non-Git directories retain the existing
continuous file-sync behavior.

## Inspect local and remote work

```sh
juiced claude ls
juiced claude peek
juiced claude peek src/
juiced claude peek --include-ignored .env
```

`ls` shows immediate local and remote entries side by side; `peek` hides matching
entries. Each directory represents its descendants, so a repository with many
files stays compact. Pass a directory to inspect its immediate children, or a
file to compare that entry. Both commands include uncommitted changes using
temporary Git trees without modifying the real index, objects, refs, or files.

Ignored untracked files are excluded by default. Tracked files remain included.
An included path whose counterpart is ignored shows `[ignored]`, rather than
claiming the counterpart is absent. `--include-ignored` requires an explicit
path and includes ignored contents only within that scope. Normal Git filters
and line-ending rules apply. No file contents cross the network for this view.

Inspection uses SDK session requests and Git, with no Claude sign-in, model
turn, or Cantelop CLI dependency. A missing workspace is reported without being
created. Incomplete or excluded comparisons exit with status 2; complete views
exit 0 even when differences exist. Read failures never appear as empty folders.
See [workspace inspection](workspace-inspection.md) for symbols and limitations.

## Send local work

```sh
juiced claude sync --to-workspace
juiced claude sync --to-workspace --include-uncommitted
juiced claude
```

The first command transfers commits. The second also includes staged and
unstaged tracked changes, deletions, binary contents, executable modes, symlinks,
and non-ignored untracked files. Git's ignore rules control untracked-file
inclusion. Tracked files are included even if their names match the old file-sync
exclusions. The local index and working tree remain untouched. The staging
distinction is preserved remotely; transferring a snapshot creates no commit.

Use the snapshot command before the first launch to initialize a workspace with
uncommitted work. Existing remote checkouts must be clean, with history that can
advance to the local commit. Commit or reconcile remote work before sending
another snapshot. A different local branch requires a fresh workspace selection.

## Import and apply results

```sh
juiced claude sync --from-workspace
juiced claude fast-forward
```

Importing preserves the original remote commits and branches under
`refs/remotes/juiced/<workspace>/`. The `HEAD` ref identifies the exported remote
checkout. Each import also retains immutable refs under
`refs/juiced/imports/<workspace>/`, preserving earlier imported commits if a
remote branch is rewritten. Importing does not update local files or branches.
Remote uncommitted edits stay remote until committed.

`fast-forward` imports results and explicitly advances the clean local source
branch. It refuses detached local HEADs, branch changes, dirty working trees,
and divergent history. Imported commits remain available even when applying
them is refused. It never automatically merges, rebases, resets, or stashes.

When the agent commits a snapshot originally sent from your machine, your local
snapshot is still uncommitted. Review and preserve that local work before making
the checkout clean for fast-forwarding. Automatic snapshot reconciliation is
not implemented.

## Sessions and recovery

Multiple terminals can start sessions sharing the same checkout. Their files and
Git branch are shared. Outbound transfers require all those sessions to close.
Imports can run during active sessions because they export pinned commits.
Maintenance ownership is coordinated through the workspace database. Expired
owners are stopped through the SDK before their stale leases are removed.
After a normal session stop, the local client also removes that stopped owner's
registrations, so abrupt sandbox shutdown cannot leave the checkout busy.

Transfers use Git bundles and binary patches over authenticated SDK messages and
streams. Upload retries check offsets and existing bytes; downloads resume from
the event cursor and verify a SHA-256 digest. Changes are prepared in a separate
candidate directory and published only after validation. A persistent journal
finishes interrupted publication before checkout reuse. Ignored remote files
are retained when updating an existing checkout.

Existing file-sync workspaces containing files without a Git binding are
preserved. Select a fresh workspace to adopt Git mode:

```sh
juiced --workspace my-project-git claude sync --to-workspace --include-uncommitted
juiced --workspace my-project-git claude login
juiced --workspace my-project-git claude
```

Maintenance commands use Cantelop authentication and do not require Claude
sign-in. Launching Claude still requires sign-in for the selected workspace.
All Git commands are nested under `claude`. Reserved subcommand names can be
sent as literal prompts with `juiced claude -- login`, `juiced claude -- sync`,
`juiced claude -- fast-forward`, or `juiced claude -- delete`.

The first version requires a repository with an initial commit and complete
history. Submodule transfer is not supported; Git LFS object transfer is not
provided. A transfer is limited to 512 MiB, and each snapshot diff to 64 MiB.
Failed transfers preserve their remote temporary data for diagnosis; there is
no automatic garbage collection of abandoned transfers or retained import refs.

## Delete a workspace

```sh
juiced claude delete
juiced --workspace my-project-git claude delete
# Explicit confirmation for scripts:
juiced claude delete --yes
```

Deletion uses the same canonical local path and workspace override as launching
Claude. It shows the slug and canonical workspace ID, then asks you to type the
slug. Scripts must pass `--yes`. An absent workspace is a no-op; the command
never creates a workspace just to delete it.

This deletes the entire remote workspace, stopping its sessions and removing
all project folders, remote Git history, uncommitted edits, Claude login, and
database data. This includes other project folders sharing an overridden
workspace. Import remote commits you want to keep before deleting. Local files,
branches, and previously imported Git refs are retained.

Deletion uses the SDK's `workspace.inspect()` and `workspace.delete()` with
the same configured app credentials as Juiced's other SDK operations. It does
not shell out to Cantelop or require account login or Claude sign-in. Juiced
uses the published SDK 1.3.0 release, which includes
[SDK PR #57](https://github.com/stepandel/cantelop-sdk/pull/57).

Platform support was added in
[Cantelop PR #355](https://github.com/stepandel/cantelop/pull/355). The Juiced
App Edge must also be built with SDK 1.3.0 or newer. The two commands
do not start a Session Sandbox or require a matching Session runtime identity.
Local `cantelop dev` supports inspection but returns
`workspace_deletion_unavailable_in_local_dev` for deletion.

Remote purge is asynchronous. Wait for deletion to finish before launching
again; a later launch creates a fresh workspace from the current local HEAD
(or local file sync for non-Git directories), and requires Claude sign-in again.

## Build and verify

```sh
npm run check
npm test
npm run test:delete:local
npm run test:delete:live
npm run build
npm run build:runtime
cantelop deploy
npm run test:git:live
```

Build the CLI and deploy the Juiced app runtime from matching sources. Git
transfers require no Cantelop platform change or SDK upgrade. Workspace deletion
requires the Cantelop support described above.

`test:delete:local` uses a loopback fixture. `test:delete:live` uses the configured
app credentials and creates its own randomly named disposable workspaces. It
checks missing-workspace behavior, confirmation, deletion, database isolation on
slug reuse, safe retries against the old ID, and local file preservation. The
child CLI runs with an empty PATH and no account credentials. This test does not
accept a workspace override or start Claude, and cleans up its remote fixtures.

Hosted deletion verification passed on October 19, 2026 against Juiced v9 with
SDK 1.3.0, alongside 87 local tests, the type check, and both builds. Both
disposable workspace IDs were archived for asynchronous purge. See the
[deletion verification evidence](../diagnostics/workspace-delete-2026-10-19.json).

The Git live test uses a uniquely named disposable Git project in
`JUICED_WORKSPACE` (default `default`), which
must already be signed in to Claude. It approves only exact fixture Bash
commands, checks two concurrent sessions, imports and fast-forwards an agent
commit, and removes its remote fixture. It uses the Claude subscription.

Hosted verification passed on October 19, 2026 against Juiced v8, alongside 59
local tests and both builds. It covered the snapshot, two concurrent sessions,
commit import, optional fast-forward, and outbound sync after session shutdown.
See [verification evidence](../diagnostics/git-release-2026-10-19.json).
