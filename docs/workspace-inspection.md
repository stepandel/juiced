# Workspace inspection design

`juiced claude ls` should show an aligned local and remote file inventory.
`juiced claude peek` should show the same comparison with matching rows hidden.
Both commands compare current filesystem contents, including uncommitted work,
without transferring or applying changes. They observe the current local Git
project and its selected remote checkout.

This is an implementation contract. The commands are not implemented yet.
The [probe](../scripts/probe-workspace-inspection.mjs) and
[recorded results](../diagnostics/workspace-inspection-design-2026-10-19.json)
test the filesystem assumptions behind it.

## Command contract

```text
juiced [--workspace SLUG] claude ls [PATH]
juiced [--workspace SLUG] claude peek [PATH]
```

Both commands inspect recursively. PATH is one literal file or directory path
relative to the launch directory; its default is `.`. A file selects one entry,
including a symlink itself. A directory selects its descendants, with a path
boundary so `src` does not select `src-old`. Reject absolute paths and parent
traversal before making remote requests. Support `--` before a filename beginning
with a dash. Help runs locally. `juiced claude -- ls` and `juiced claude -- peek`
continue to send literal Claude prompts, as other reserved commands do.

The two commands use one comparison model and renderer; `peek` changes only the
row filter. There is no separate `--all` mode because `ls` supplies that view.
PATH filters the comparison; it never opens a content diff. The initial scope
excludes content viewers, interactive directory navigation, arbitrary pairs of
workspaces, and the legacy non-Git sync mode. Non-Git directories receive a clear
unsupported-mode message without starting synchronization.

Retain the existing workspace selection from the canonical launch directory,
including `JUICED_WORKSPACE` and `--workspace`. Discover the repository using the
same Git eligibility and binding as existing Git commands: an initial commit and
complete history. Preserve linked local worktree support. From a subdirectory,
compare that subtree of the repository against the corresponding subtree of the
remote checkout. Do not recompute the workspace slug from the repository root.
The header must identify the repository roots and selected relative scope,
because Juiced currently derives the remote folder name from the launch folder.

Use exit status 0 for a completed comparison, whether or not files differ; 1 for
usage, authentication, or transport failure; and 2 for an incomplete comparison,
including an unreadable entry or unavailable counterpart checkout. A requested
path confirmed absent on both sides produces an explicit message and exit 0.
SIGINT retains the existing exit status 130.

## Which paths belong in the view

Enumerate each checkout independently with
`git ls-files --cached --others --exclude-standard -z`, deduplicating paths that
appear more than once in the index. Use the existing Git helper's disabled hooks,
disabled optional locks, and noninteractive execution. Pin Git's directory and
worktree to the verified checkout so inherited Git environment variables cannot
redirect inspection.

Take the union of those two inventories, then inspect every candidate path on
**both** filesystems. An eligible path on one side can exist as an ignored file
on the other side. That counterpart must still be examined. The probe establishes
this case: `ignored-on-remote.txt` is absent from the remote Git inventory but
has matching bytes on both sides.

Tracked files remain eligible even when their names match ignore rules. Files
ignored and untracked on both sides are excluded. The header states this scope;
the view must not claim to list every disk entry. `.git` and Juiced's workspace
metadata are outside the inventory. Never start the legacy sync helper to obtain
an inventory.

Index entries supply candidates, not proof that a file exists. A tracked path
deleted on one side becomes a one-sided row; one deleted on both sides is
omitted. Empty directories have no row. When a directory replaces an eligible
file, show the type conflict at that path and suppress descendant comparison
rows beneath it. Report a submodule as indeterminate and do not traverse its
checkout. A requested scope below a conflicting or unreadable ancestor is
unavailable. Renames appear as one-sided paths; there is no similarity inference.

Preserve path spelling and case exactly, with deterministic UTF-8 byte ordering.
Parse NUL-delimited output without line splitting or trimming. Reject names that
cannot round-trip through the protocol's UTF-8 strings and mark the scope
incomplete; replacement characters must not merge distinct paths. Display
terminal controls, newlines, tabs, and bidirectional formatting controls as
escaped characters rather than executing or laying them out.

## What each result means

| Marker | Result | Required observation |
| --- | --- | --- |
| `=` | Matching | Both regular files have equal bytes and the same Git executable bit, or both symlinks have equal raw target text. |
| `!` | Different | Both entries exist and differ in contents, Git executable bit, type, or symlink target. Include the observed reasons. |
| `L` | Local only | The local entry exists and the remote path is confirmed absent in a readable, stable parent. |
| `R` | Remote only | The remote entry exists and the local path is confirmed absent in a readable, stable parent. |
| `?` | Indeterminate | Required observations failed, changed during inspection, or have an unsupported type. State the reason. |

Use `lstat` to distinguish entries and `readlink` to compare symlink target text,
including broken links. Never hash the destination of a symlink. Reject traversal
through symlink ancestors. Open regular files without following a final symlink,
and verify that the opened descriptor belongs to the entry that was inspected.
Do not open FIFOs, sockets, or devices as regular files.

Compare regular files using streaming SHA-256 digests; a stable size mismatch can
establish a content difference immediately. File size or modification time alone
cannot establish equality. The probe includes equal-size files with equal mtimes
and different bytes. Text, binary files, and Git LFS pointer files use the same
raw-byte comparison. No text conversion, line-ending normalization, filters, or
LFS downloads run.

The executable bit follows Git's `100644` versus `100755` distinction, based on
the owner execute bit. Other permissions, ownership, timestamps, and extended
attributes do not affect equality. The probe verifies that a group-execute-only
change is also ignored by Git. Report a permission error as indeterminate even
when other metadata appears to match.

Compare the current working tree, not the staged version. Different staged
contents with equal current file bytes produce a matching row; the probe checks
this explicitly. Header metadata shows each actual checked-out branch or detached
HEAD and commit ID separately. The binding's `sourceBranch` is not necessarily
the remote's current branch. Different commit IDs do not imply different files;
do not report ahead or behind counts without the necessary history evidence.

## Live reads and incomplete comparisons

The view represents sequential observations, not an atomic snapshot of two
machines. Record each side's observation interval and always label the output
`Sequential live reads`. Even a successful scan cannot prove that neither side
changed immediately after it was read. A matching view describes observed file
state; it does not establish that a subsequent sync will succeed.

Capture root identity, binding, HEAD, index bytes, and candidate inventory before
and after the operation. For files, compare device, inode, type, size, mtime, and
ctime before and after hashing, using nanosecond values where available. Check
both descriptor and path identity. Recheck symlink targets and ancestor identities.
Revalidate the candidate inventory, root, binding, and publication journal before
declaring the comparison complete. Changed entries become indeterminate; changed
inventory or root identity makes the scope incomplete. Never silently recapture
one side and combine it with old results from the other.

These checks detect ordinary concurrent changes; they do not provide filesystem
snapshot isolation. The probe pauses a read, overwrites the file with equal-length
bytes, restores its mtime, and confirms that the changed observation is rejected.
If reliable identity or timestamp observations are unavailable, mark the affected
scope indeterminate instead of weakening the check silently.

A missing workspace, missing project folder, absent or mismatched Git binding,
pending publication journal, or unsupported runtime produces an explicit
unavailable-comparison message. Do not label all local files local-only when
there is no paired checkout. Do not treat an authorization failure, incomplete
inventory, timeout, or unreadable parent as an empty directory. Retain useful
completed rows when possible, but show `Incomplete comparison` and omit any
claim that the displayed counts cover the entire scope. Zero displayed
differences is never presented as equality when any required observation failed.

## Side by side output

At 80 columns, a full inventory could look like this. Roots, workspace identity,
branch and HEAD metadata, scope, and the live-read label precede the rows.

```text
Local: /projects/app
Remote: app-a1b2 /workspace/app
Scope: .
Files: tracked and non-ignored untracked
Sequential live reads

LOCAL                          REMOTE
.gitignore                  =  .gitignore
README.md                   =  README.md
link                        !  link
  symlink targets differ
private.txt                 ?  private.txt
  local: permission denied
scripts/run.sh              !  scripts/run.sh
  executable bits differ
src/draft.ts                L  -
-                           R  src/generated.ts
src/index.ts                !  src/index.ts
  contents differ

2 matching | 3 different | 1 local only | 1 remote only | 1 indeterminate
Incomplete comparison: private.txt could not be read.
```

`peek` hides the two `=` rows and retains the same counts and warning. With no
differences and a complete scan, print `No differences observed` with the live-read
label. Keep the symbols and reason text even when color is available.

At 40 columns, wrap each cell independently with blank continuation markers;
never truncate the part of the path that identifies a file. For example:

```text
LOCAL               REMOTE
packages/api/lo  !  packages/api/lo
ng-name.ts          ng-name.ts
  contents differ
src/draft.ts     L  -
-                R  src/generated.ts

1 different | 1 local only
1 remote only | 0 indeterminate
```

Measure terminal cell widths, including printable Unicode, with a tested width
utility. Wrap the header, reasons, and counts as well as paths. Below the width
needed for two useful columns, fall back to a labeled local/remote pair per row.
Piped output is plain, deterministic, and untruncated, with no progress animation
or ANSI escapes. Progress and failures use stderr; the view uses stdout. The
examples specify layout behavior; automated rendering verification belongs to
the implementation acceptance checks below.

## Read only execution path

Inspect the slug with SDK `workspace.inspect()` before requesting a session. If
absent, return the unavailable-comparison result without calling resolve, auth,
sync, database, or session methods. If present, validate the response and use
its canonical workspace ID for every subsequent request. A workspace deleted
and recreated under the same slug must not redirect an in-flight inspection.
The SDK recording-connection probe verifies absent lookup without a session and
request serialization using the inspected canonical ID. It makes no hosted calls.

Route both commands before the normal Claude branch in `src/cli.ts`, as deletion
already is. Use a dedicated typed inspection protocol and client. There is no
Claude login or model turn, no Git bundle import, and no call to `send`, `receive`,
`status`, or `createGitSession`.

The existing Git path is unsuitable for a read-only implementation:

| Code touchpoint | Existing behavior and implementation consequence |
| --- | --- |
| `src/args.ts` | Reserve `ls` and `peek`, validate one optional path, and retain literal-prompt escaping. |
| `src/cli.ts` | The general Claude branch signs in, initializes a Git checkout, or starts sync. Dispatch inspection before it. |
| `src/project.ts`, `src/git.ts` | Reuse project selection and repository binding; keep path scope distinct from the launch identity. |
| `src/runtime/git.ts`, `projectPaths` | Creates `.juiced/<project>/transfers` even for status. Build a separate resolver that only reads existing paths. |
| `src/runtime/git.ts`, status and recovery | Status can recover a publication journal by renaming files. Inspection reports the pending journal and preserves it. |
| `src/git-workspace.ts`, `call` | Can stop stale owners and reap their leases. A dedicated inspection client must never take that recovery path. |
| `src/runtime/project-state.ts` | Checkout leases write SQL and can block maintenance. Inspection uses identity and mutation checks rather than acquiring a checkout lease. |
| `src/protocol.ts`, `src/runtime/terminal.ts` | Add and dispatch inspection messages independently of Git maintenance and terminal startup. |

Keep the metadata resolver, filesystem observation model, comparison function,
and renderer separate. One filesystem observer can run locally and remotely;
the comparison and rendering run locally. A read-only resolver validates existing
metadata and project directories without calling `projectPaths` or recovery.

Use three logical protocol operations: inventory, observe, and finish. First,
stream the remote candidate paths and capture the read guards. Next, form the
union locally and observe it on both sides, sending remote paths in bounded
batches. Finally, validate the remote guards and the local observations before
declaring completeness. Use an inspection ID, ordered batches, and explicit end
records so a lost stream cannot be mistaken for an empty or complete inventory.
Keep guard state in the inspection session's memory and expire it at the end of
the 240-second operation deadline; persist no manifests or hashes in the checkout.

SDK 1.3.0 limits commands to 1 MiB and output events to 64 KiB. Bound serialized
requests and events to 48 KiB, including escaping and envelope overhead, and
cap cumulative inventory data at 64 MiB, consistent with the Git helper's
existing output bound. Check response validation and cancellation on every batch.
If any bound or deadline is reached, report incomplete data explicitly. Finish
or failure stops only the inspection's own session. A dropped operation restarts
as a new observation rather than merging partial runs.

Read-only applies to project files, Git objects, index, refs, configuration, and
existing Juiced checkout metadata. Cantelop still records requests and events and
may start its own inspection sandbox. Reading files can update access times;
access times are excluded from the preservation check. No project database
lease writes, stopped agent sessions, automatic repair, or synchronization occur.

## Evidence and implementation acceptance

Run the reproducible probe after installing the repository dependencies:

```sh
node --import tsx scripts/probe-workspace-inspection.mjs
```

The recorded macOS run used Node 26.8.1, Git 2.55.0, and SDK 1.3.0. It checks
19 candidate paths against explicit expected classifications and an independent
oracle using whole-buffer byte equality. Eighteen paths remain after omitting
the path absent on both sides. Cases include binary differences, equal mtimes,
different staged versions, deletions, new files, ignored counterparts, tracked
ignored files, symlinks, type changes, executable bits, unusual names, and an
actual permission failure. The mutation check rejects an interrupted read.

Before and after the stable comparison, the probe compares file bytes, entry
types, modes, identities, timestamps other than atime, and the entire fixture
`.git` trees, including index and refs. They are unchanged. Separately, it invokes
the actual existing status handler with a recording database and confirms that
status creates `.juiced` directories and inserts and deletes checkout leases.
These are design findings, not passing tests of unimplemented commands.

The smallest implementation sequence is:

1. Add the observation model and pure comparator. Turn the probe cases into
   focused tests, retaining direct-byte and explicit-expectation oracles. Add
   file/directory conflicts, unsupported entries, invalid encodings, symlink
   ancestors, case differences, and index/HEAD or inventory changes during reads.
2. Add the read-only remote resolver, bounded inspection protocol, and client.
   Use the real SDK with a disposable runtime fixture. Assert canonical-ID
   routing; no session or provisioning on missing lookup; no fallback after
   deletion; and no auth, sync, maintenance, recovery, or agent-stop calls. Test
   lost and out-of-order batches, incomplete end records, bounds, and aborts.
3. Add the two CLI actions and shared renderer. Assert that `peek` equals `ls`
   with matching rows removed, including identical ordering and summary counts.
   Check 80- and 40-column layouts, long and Unicode paths, escaped controls,
   pipes, literal path filtering, exit codes, and literal Claude prompt escaping.
4. Run the type check, relevant existing tests, both builds, and one hosted
   verification against a uniquely named disposable workspace with a matching
   runtime. Prove file/index/ref/metadata preservation and continued operation
   of an already-running agent session. Also inspect a never-created slug and
   verify that it remains absent. Deploy through the normal release workflow.

Acceptance requires agreement with independent filesystem observations and the
preservation assertions, as well as successful CLI/runtime integration. The
current probe covers the filesystem assumptions and SDK capabilities; production
transport, rendering, containment, and hosted integration remain implementation
acceptance work.
