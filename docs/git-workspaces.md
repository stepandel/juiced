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
or `juiced claude -- fast-forward`.

The first version requires a repository with an initial commit and complete
history. Submodule transfer is not supported; Git LFS object transfer is not
provided. A transfer is limited to 512 MiB, and each snapshot diff to 64 MiB.
Failed transfers preserve their remote temporary data for diagnosis; there is
no automatic garbage collection of abandoned transfers or retained import refs.

## Build and verify

```sh
npm run check
npm test
npm run build
npm run build:runtime
cantelop deploy
npm run test:git:live
```

Build the CLI and deploy the Juiced app runtime from matching sources. No
Cantelop platform change or SDK upgrade is needed. The live test uses a uniquely
named disposable Git project in `JUICED_WORKSPACE` (default `default`), which
must already be signed in to Claude. It approves only exact fixture Bash
commands, checks two concurrent sessions, imports and fast-forwards an agent
commit, and removes its remote fixture. It uses the Claude subscription.

Hosted verification passed on October 19, 2026 against Juiced v8, alongside 59
local tests and both builds. It covered the snapshot, two concurrent sessions,
commit import, optional fast-forward, and outbound sync after session shutdown.
See [verification evidence](../diagnostics/git-release-2026-10-19.json).
