# Local publication from Claude

Interactive `juiced claude` Git sessions expose three tools through the built-in
`juiced-local` MCP server. A standalone Claude plugin is not required. Juiced
injects the server at native process startup through `--mcp-config`; it does not
edit the project's `.mcp.json` or install a user-wide server.

`publish_commits` and `publish_snapshot` transfer remote work to the laptop.
`pull_local_changes` transfers laptop work into the remote checkout. All three
require a separate local approval, even if Claude's tool permissions allow them.

## Pull laptop work into the remote checkout

Ask Claude: **Pull my latest laptop changes into this workspace.**
`pull_local_changes` takes a `summary` and optional `include_uncommitted` boolean
(default `true`). The attached client captures an immutable upload before showing
its local directory, commit, changed-path preview and byte count. Approval starts
the upload; denial sends no snapshot bytes. Subsequent laptop edits are excluded.
Local files, HEAD and staging remain unchanged. The full repository is transferred
even when the conversation starts in a subdirectory, using the existing pairing.

The remote HEAD is pinned when the request begins. Application requires a clean
remote checkout whose HEAD has not changed and is an ancestor of the captured
local HEAD. The local source branch must match the original workspace pairing.
Another session's checkout lease blocks application, including an expired lease;
this tool never stops another session automatically. The requesting session can
remain open because its native process is waiting for the MCP result.

The runtime validates a candidate checkout and applies a checked Git binary patch
in place, preserving Claude's working directory and local staged/unstaged changes.
An upload that would remove or replace the session's working directory is refused.
Ignored files remain excluded unless tracked, and collisions with ignored remote
files are refused. The tool reports success only after remote files, HEAD, index,
and the shared publication baseline have been updated. Claude can then continue
working and publish its follow-up edits back to the laptop.

Do not run concurrent tools or background jobs that write to this checkout during
application. Git owns its index/ref locks; unrelated file writers do not take
Juiced's checkout lease. Dirty work and divergent histories require explicit
reconciliation; the tool never merges, stashes, resets, or deletes that work.
Uploads retain immutable refs under `refs/juiced/uploads/<transfer-id>/` and
artifacts under `/workspace/.juiced/<project>/transfers/<transfer-id>/`. If a
process or filesystem failure interrupts the multi-step in-place update, inspect
the checkout and retained `live.patch`/`live-started.json` before retrying. A
started transfer without a completion receipt is never automatically applied again.
The same five-minute deadline and transfer/path limits described below apply.

An offline client can review an unexpired request after reconnecting; it captures
a new local snapshot for fresh approval. Detaching discards its unapproved local
snapshot. Build/install the updated CLI and deploy the matching runtime together;
restart existing native Claude processes to load the new MCP tool.

## Publish remote work to the laptop

For example, ask Claude:

> Commit this change, then publish the commit to my local checkout.

Or, without requiring a user commit:

> Bring these edits back to my local checkout as uncommitted changes.

`publish_commits` takes a summary and an optional full commit SHA. Without a SHA,
it pins remote HEAD when the call begins. `publish_snapshot` takes a summary and
captures Git-visible working files, including additions, deletions, binary bytes,
symlinks and executable modes. Ignored untracked files remain excluded; tracked
files are included even when their names match ignore rules.

Claude's normal MCP permission checks still apply. Once the artifact is prepared,
Juiced presents a separate **local checkout** confirmation showing the summary,
commit and snapshot identifiers, changed-path count and up to 20 path names.
**Deny** is selected by default. Pasted text cannot select Allow. Each offer is
approved individually, even if Claude's remote permission mode permits MCP tools.
Creating or viewing an offer does not change local working files.

## Applying commits

The client imports the immutable bundle and fast-forwards the local source branch
only if its branch, clean working tree and ancestry still permit the operation.
Detached HEADs and divergent histories are refused. The original commits and
branches are retained under the same Juiced import refs used by manual imports.
The requested commit stays fixed even if Claude creates more commits while you
review the offer. There is no automatic merge, rebase, stash or reset.

## Applying file edits

The initial shared baseline is the snapshot sent to Cantelop, including local
uncommitted work when `sync --to-workspace --include-uncommitted` was used. Older
workspaces without a recorded baseline use the local launch commit's tree.
Successful publication records the next baseline. Denial and failure leave it
unchanged. Snapshot publication can include changes already committed remotely;
locally, they remain uncommitted and local HEAD stays at its baseline commit.

The transfer carries the baseline tree, resulting tree, and a Git binary patch.
Transport-only commits retain those trees in the bundle without moving remote
HEAD, creating a user commit, or changing its real index. The local client verifies
the bundle and patch against the declared trees using a private index.

Before application, the client checks that local HEAD matches the baseline and
that each affected file still matches the baseline. Unrelated local edits are
preserved. Overlapping edits, existing untracked or ignored file collisions, and
symlink ancestors are refused. Edits already present locally are recognized.
Successful application changes working files only: the real index, including
existing staged work, is preserved. Subsequent publications compare against the
last successful snapshot rather than the original commit.

Snapshot and commit publication are alternative ways to receive work. After
receiving a snapshot, its uncommitted local edits prevent fast-forwarding commits
until you reconcile them. If you advance local HEAD outside this bridge, the
snapshot baseline check may require a new explicit transfer to establish a shared
baseline. Automatic three-way merging of local changes is not implemented.

## Connection, ownership and recovery

Claude's MCP subprocess runs on Cantelop. It connects to a private Unix socket in
that session's runtime, which sends publication offers through Juiced's existing
authenticated SDK connection. The local client downloads artifacts through the
same Git transfer protocol. No laptop port, public MCP endpoint, tunnel or GitHub
credential is needed.

An attached local TUI must approve and execute the request. A detached or offline
session can keep working remotely; publication waits up to five minutes. A
reconnected client may review an offer only while it remains pending in the live
runtime. Historical journal entries cannot authorize writes. If the native process
is lost, pending offers are invalidated. Existing saved conversations gain the
server on their next native process start, including after idle sleep; `/exit`
and `juiced claude` in the same tab restart it immediately.

Only one outstanding publication is allowed per remote project, and only one
local client can claim an offer. A Git compare-and-swap ref serializes local
publications across Juiced clients and linked worktrees. Local receipts recognize
completed transfer identities, so retrying or replaying them does not write the
files again. Expiration and cancellation stop further application attempts. If a
connection or process fails during an approved operation, check the local checkout
before retrying; a write may have completed without its acknowledgment arriving.

Imported refs remain at `refs/juiced/imports/<workspace>/<publication-id>/`.
Downloaded snapshots, their manifests and receipts are retained under the local
Git path `juiced-publications/<workspace-hash>/<publication-id>/`; use
`git rev-parse --git-path juiced-publications` to locate it, including in a linked
worktree. Conflicting snapshots retain `snapshot.patch` there for review. Remote
exports and baseline refs are also retained; automatic garbage collection is not
implemented.

This version supports interactive Git sessions. Non-Git directories retain their
explicit file-sync workflow; print/native passthrough sessions do not expose the
bridge. Sparse checkouts, submodules and embedded repositories are unsupported.
Snapshots are limited to 4,096 changed paths and a 64 MiB patch; the complete export
is limited to 512 MiB. Files should remain stable during capture and application;
Juiced detects changes at its validation boundaries and Git owns index/ref locks,
but unrelated editors and shell commands do not participate in Juiced's lock.

## Verification

```sh
npm run check
npm test
npm run build
npm run build:runtime
```

`test/local-publish.test.ts` launches the actual stdio MCP program, transfers its
artifacts through a real SDK adapter into disposable Git repositories, and checks
commits, successive dirty snapshots, staging and binary preservation, conflicts,
corruption and exclusive claims. Durable-agent and TUI tests cover replay,
reattachment, local approval, denial and paste handling. Socket-based tests need
permission to create private local sockets; no hosted deployment or model call is
required. Both builds must be deployed from matching sources before hosted use.

Protocol references: [Claude MCP configuration](https://code.claude.com/docs/en/mcp),
[MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
and [MCP tool calls](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
