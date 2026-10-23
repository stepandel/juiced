# Workspace inspection

`juiced claude ls` lists immediate remote files and directories.
`juiced claude peek` compares immediate local and remote entries side by side,
including matching entries. Use `peek --changes-only` to hide matches. A directory
row compares everything beneath it; child files appear when you drill into that
directory. The commands inspect Git working trees through the SDK without
starting Claude or synchronizing files.

## Commands and output

```sh
juiced claude ls
juiced claude ls src/
juiced claude peek
juiced claude peek --changes-only
juiced claude peek src/
juiced claude peek src/index.ts
juiced claude peek --include-ignored .env
juiced --workspace my-project claude peek
```

`ls` shows remote names in a single column, with `/` after directories and `@`
after symlinks. Submodules and embedded Git repositories have a `[submodule]`
label; their contents are not traversed. Its header identifies the workspace and remote path; it has no
local column or comparison counts. Local-only files are absent from this list,
and local file contents are not inspected.

A typical `peek` root view contains one row per immediate entry:

```text
  Workspace  juiced                     wsp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  Local      /Users/you/code/juiced     main a7f3c9d2e1b4
  Remote     /workspace/juiced          main c04be71f33a9

  LOCAL             REMOTE
  README.md      =  README.md
  docs/          L  -
  package.json   !  package.json
  -              R  scripts/
  src/           !  src/

  = 1 matching   ! 2 different   L 1 local only   R 1 remote only
  Git view; ignored files excluded. One level; directory status includes descendants. Sequential live reads.
  Drill into a directory: juiced claude peek PATH
```

`peek src/` displays the immediate entries in `src`, including summaries of its
subdirectories. The footer counts entries at the selected level, including
matching entries hidden by `--changes-only`. That flag is supported only by
`peek`; `ls --changes-only` is rejected. Each count carries the symbol it
explains, and statuses no entry has are left out. The comparison symbols mean:

| Symbol | Meaning |
| --- | --- |
| `=` | Matching Git entry or directory tree |
| `!` | Different Git contents, type, or executable bit |
| `L` | Included only in the local Git snapshot |
| `R` | Included only in the remote Git snapshot |
| `?` | Comparison excluded by ignore rules or a nested Git repository |

Comparison headers identify the selected workspace and canonical ID, local and
remote paths, and both actual branch names and HEADs, with each path beside its
Git ref. Symlinks have an `@` suffix; comparison uses their target text.
Directory rows have a `/` suffix. Columns take the width their names need and
share the terminal only when the names cannot all fit, wrapping independently
without truncation. Below 30 terminal columns, each entry is named once and
annotated only where the two sides disagree. Printable Unicode retains its
display width; controls and bidirectional formatting characters are escaped, and
an escape is never split across wrapped lines. Differences carry colour on a
terminal, with a hue per side and matching rows dimmed; piped output, `NO_COLOR`,
and `TERM=dumb` stay plain and untruncated. Errors use stderr.

PATH is a literal relative path beneath the launch directory; its default is
`.`. Absolute paths, parent traversal, Git metadata paths, and traversal through
symlink ancestors are rejected. Use `--` for a path beginning with a dash.
`juiced claude -- ls` and `juiced claude -- peek` remain literal Claude prompts.
Help runs locally. Workspace selection and nested-directory binding follow the
existing Git workspace commands, including linked local worktrees.

Exit status is 0 for a completed view, including views containing differences;
1 for usage, authentication, or transport failures; and 2 for incomplete or
excluded comparisons. Missing workspaces and unavailable project checkouts are
reported explicitly. `ls` also exits 2 for a missing or excluded remote path.
A `peek` path confirmed absent on both sides has no rows and exits 0. SIGINT
retains the CLI's status 130.

## Git snapshots and ignored files

Git supplies the comparison model. For `peek`, each side copies its existing
index into a private directory, stages current contents into a temporary object
directory, and writes a temporary tree. Valid Git stat entries avoid rereading
unchanged ordinary files. Inspection clears assume-unchanged, skip-worktree,
fsmonitor and untracked-cache flags in the copy, forces ctime checks, verifies
file readability, and preserves Git's protection against racy timestamps.
Files needing clean filters, attributes-based conversions, or automatic line
ending conversion use a rebuilt index with fresh hashes instead. No computed
snapshot or file hash is cached across commands. This captures tracked edits, deletions,
staged additions, and non-ignored untracked files. The real index, Git object
store, refs, and working files are unchanged. No temporary commit is created.
`ls` uses local repository metadata to resolve the existing workspace pairing and
relative path. On the remote side, Git enumerates tracked and eligible untracked
paths, and filesystem metadata supplies their types. Listing does not read file
contents, run clean filters, create temporary objects, or hash directory trees.

A directory's tree ID represents its descendants, allowing the client to compare
directory summaries without downloading files or importing bundles. Only the
immediate entries and their Git IDs cross the network. Different HEADs can have
matching current trees; uncommitted edits can make equal HEADs differ.

Normal Git ignore rules apply to both commands; clean-filter and line-ending
rules apply to comparisons. This is a Git view
of current contents, not a byte-for-byte inventory of every filesystem entry.
Tracked files remain included even when they match ignore rules. Ignored
untracked files are excluded unless requested.

If a path is included on one side but has ignored contents on the other, the
excluded cell shows `[ignored]` and the row is marked `?`. It is not called
missing. Git enumerates ignored paths with directory aggregation; their contents
are not staged or compared by default. Paths ignored on both sides have no
ordinary inventory row.

`--include-ignored` requires an explicit PATH. Git force-adds ignored contents
only inside that selected scope in the private snapshot. For example, comparing
`.env` does not include `node_modules`. The flag can also explicitly select a
directory, including `.`. Git metadata is always outside the comparison.

## Live reads and failures

The `peek` footer labels the view as sequential live reads. Git captures each side
independently, so the view is not an atomic snapshot across machines and cannot
guarantee that a later sync succeeds. Git checks the temporary index against the
working tree after capture; root identity, HEAD, branch, real index bytes,
candidate inventory, and ignored inventory are checked for changes. Detected
changes require a retry instead of combining old and new data silently.

Submodules and embedded Git repositories appear as excluded rows with a
`[submodule]` label. A directory containing one is marked `[contains submodule]`
and excluded because its Git tree cannot describe the nested repository's
working files. The remaining rows are compared normally; `peek` exits 2 to
indicate a partial comparison. Equal submodule commit IDs do not imply equal
working contents. `--include-ignored` does not include nested repository contents.
Selecting a path inside a nested repository produces an error naming that
repository; selecting its parent lets you inspect the other files. `ls` can
list a nested repository itself without reading its contents.

An unreadable entry or unsupported special file produces an incomplete
comparison. Sparse checkouts receive explicit errors. Checkout failures identify
whether the local or remote side failed. Empty directories are outside Git's
view. Renames appear as one-sided paths, without similarity inference.

Inspection never provisions a workspace, repairs a publication journal, acquires
checkout leases, stops an agent session, or imports remote commits. A pending
publication or mismatched binding produces an error and preserves existing
state. Reading files can update access times; Cantelop still records requests
and may start the inspection's own sandbox.

## SDK and runtime implementation

The client first uses SDK `workspace.inspect()` on the selected slug. Missing
workspaces stop there. Existing workspaces are addressed by their inspected
canonical ID for subsequent requests, preventing a replacement slug from
redirecting the operation.

For managed inspection commands, bootstrap checks runtime compatibility and
supplies the recommended CLI release. The client applies any required update
before inspection without a separate public config request. Older services that
omit this field retain the config fallback. An already-ready installation does
not publish an unnecessary provisioning wake-up during bootstrap.

The Juiced runtime handles a dedicated `inspect` message through a session
activity queue. A stable inspection session is selected by the canonical workspace
ID, project folder, Git binding, and inspection protocol version. It remains warm
for 120 seconds after work becomes idle, so repeated commands can reuse its
sandbox. Concurrent inspections queue independently of Claude's sessions.

The activity resolves existing metadata without calling the maintenance path,
creates a Git snapshot or metadata-only listing, then streams 32 KiB chunks followed by an explicit
size and SHA-256 digest. The client rejects malformed, reordered, truncated, or
corrupt streams and validates the snapshot schema. Inventory data is bounded to
64 MiB and each client operation to 240 seconds. Completed activities commit a
durable event boundary; subsequent CLI invocations resume there instead of replaying
old inventories. An expired or reset stream triggers one retry in a fresh session
with no idle keep-alive. Temporary snapshot files are removed after capture.
Disconnecting or interrupting a client closes its subscription without stopping
the shared session; remote inspection work retains its activity timeout.

`ls` requests listing mode. `peek` requests content hashes, and `--changes-only`
filters matching rows on the client. Both inventory modes share the bounded
transport and workspace validation.

No SDK or platform changes are required. The runtime image already includes
Git. Juiced uses the SDK request/stream transport directly; these commands do not
call `workspace.sync()` or shell out to Cantelop. Build and deploy matching Juiced
client and app runtime sources before using the commands against a hosted
workspace. Cantelop's deployment tooling is separate from the installed Juiced
runtime requirements.

## Verification

```sh
npm run check
npm test
npm run test:inspection:local
```

The focused inspection tests cover remote-only listing, complete and filtered
comparisons, listing with unreadable local files, native Git semantics, dirty and staged work,
binaries, symlinks, modes, ignored files and directories, literal paths, narrow
terminals, directory summaries, linked worktrees, unavailable checkouts, preserved
journals, and invalid streams. Preservation checks compare complete fixture
working trees and Git directories against their original bytes and metadata.

The native runtime test checks the actual handler, session activity, output
acknowledgments, and successful inspection while database access is rejected and
the Claude executable is absent. The built CLI test passes through the real SDK
Edge adapter into a disposable platform fixture. Its PATH contains Git only,
with no account credentials or Cantelop CLI. It covers missing-workspace lookup,
canonical IDs, remote listings, complete and filtered root summaries, drill-down,
ignored inclusion, and recovery refusal. These local fixtures verify the protocol
and client; they do not deploy
a hosted app release.
