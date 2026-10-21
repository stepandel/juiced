# Diagnostics and release verification

Recorded evidence from hosted verification runs and platform investigations.

## Release verification

**Workspace deletion** — October 19, 2026, release v9
(`rel_b499d9481549a7f859bee02a37326346`), SDK 1.3.0, 87 local tests, the type
check, and both builds. Covered read-only inspection of a missing workspace
without provisioning, a no-op deletion of an absent workspace with an empty PATH,
refusal to delete noninteractively without `--yes`, deletion without a Cantelop
CLI or account login, a fresh database on slug reuse, a safe retry against the
old canonical ID leaving its replacement intact, and unchanged local files. Both
disposable workspace IDs were archived for asynchronous purge.
[Evidence](workspace-delete-2026-10-19.json).

**Git workspaces** — October 19, 2026, release v8
(`rel_a8791118a314bb0d4dbc310041d12810`), 59 local tests and both builds, with no
platform or SDK changes required. Transferred an unpublished `HEAD` and staged
snapshot without changing the local index, attached two separate Claude sessions
to one checkout, refused outbound checkout replacement while they were active,
imported a remote commit with its original identity, refused a fast-forward over
dirty local work and then advanced the clean source branch, and completed an
outbound sync once both sessions closed. [Evidence](git-release-2026-10-19.json).

**Workspace inspection** (`ls` and `peek`) — verified locally only, with 99
passing tests on October 19, 2026 and no hosted deployment.
[Evidence](workspace-inspection-2026-10-19.json).

**Release v4** (`rel_0760c39bd457205a9bdbf5a8f1a9d56c`) — activated October 16,
2026 with published SDK 1.2.0. Signed and notarized Cantelop CLI 0.16.1
(`edb6351c0eeb`) was published, installed through Homebrew, and its macOS
signature verified. The runtime ran platform commit
`edb6351c0eebc4350b1214000b376ddf6ea125a8`; Cloudflare was deployed from
`05d01a27b8dc77496f0dc90904491d285b93f4f6`.

File-sync qualification enabled hosted writes against the real JuiceFS data
mount and a disposable loopback NFS export. It covered both transfer directions,
stale versions, competing clients, NFS write/rename/delete/type changes during
upload, interruption cleanup, and sibling confinement. Qualification exposed a
trash-retained hard link from file publication; new files now use atomic
no-overwrite rename through pinned directory descriptors. Genuine hard links
remain rejected. Concurrency with arbitrary filesystem writers remains
optimistic.

The installed `juiced claude` uploaded a disposable local README, had real Claude
read its unique token from the remote project directory, streamed the exact
reply, and exited with code 0. The live local-TUI test separately approved one
remote Write and verified the resulting file locally through sync. Both tests
removed their remote fixture files through synchronized deletion and reused the
existing `default` workspace login. [Evidence](sync-release-2026-10-16.json).

**Release v3** (`rel_4f206ba65af1e78dac06408895053726`) — verified SDK 1.1.0 and
CLI 0.16.0 against the public sync download route, with uploads deliberately
disabled before storage qualification.

**Release v2** (`rel_3af3dee9134a99e9635b0d103c89d67c`) — October 16, 2026. The
installed `juiced claude` rendered a streamed answer, answered an
`AskUserQuestion` dialog, interrupted generation, accepted another turn, and
exited with code 0. The headless live test verified persistent conversation
context, denial and approval of a Write, remote file verification and cleanup,
interruption without duplicate output, and another successful turn. Native piped
execution also passed. Offline renderer tests verify that keystrokes and
multiline paste remain local even while the connection is stalled, and that
pasted text cannot approve an action.

**Release v1** (`rel_ac265686e609d480b2dca6d1cd8cd04b`) — October 16, 2026, app
`juiced`. The installed `juiced` command returned Claude Code `2.1.259` in both
pipe and PTY modes, passed the real prompt smoke test, and displayed the native
interactive UI. Typing a prompt through the PTY returned `JUICED_INTERACTIVE_OK`;
`/exit` returned exit code 0 and restored the local terminal. A fresh session
retained Claude sign-in and completed onboarding, with native folder trust
prompts preserved.

## Terminal latency investigation (October 16, 2026)

Ten input samples were correlated with the compute host's durable receipt
timestamps. Input visibility ranged from 430–1,639 ms and acknowledgement from
702–2,224 ms. Five slow samples spent 1,165–1,229 ms between sandbox binding and
runtime admission, while the input handler itself took 0–1 ms at its millisecond
clock resolution. A further 297–585 ms elapsed between handler settlement and the
durable handled projection. Matching terminal output reached the event store in
16–26 ms. Cross-machine timestamp splits are approximate; client elapsed
durations and the local reproductions do not depend on clock synchronization.
[Measurements](terminal-latency-2026-10-16.json).

Two issues reproduce in the Cantelop source: an admission wake consumed while the
same sandbox's worker is busy does not survive worker release, leaving the next
periodic sweep to pick it up; and reconciliation repeatedly revisits every
settled command until the whole session becomes quiescent. With 100 settled
commands, one pass makes 100 message reads, 300 execution-save calls, and 100
runtime status calls, plus fixed supervision calls. The fresh-delivery
optimization also requires a group of exactly one execution, so it does not help
an ongoing interactive session.

`npm run probe:reconciliation` asserts the observed behavior for the investigated
platform revision. It uses a temporary Go overlay and does not edit or deploy
Cantelop; its expectations should be updated after platform fixes. The
recommended platform changes are to retain admission reruns per sandbox,
prioritize new input and reply completion over old settled work, and supervise
activity/output ownership per sandbox without repeatedly rewriting every finished
command. A direct terminal WebSocket could then carry ordered bytes outside the
durable command path; switching the existing output stream to WebSocket alone
would preserve the dispatch delay. Measured TCP connection time to the current
compute host was 164–184 ms, so deployment locality remains relevant after the
platform stalls are removed.
