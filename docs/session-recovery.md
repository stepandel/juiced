# Session recovery

Interactive sessions run independently of the local terminal. Closing a laptop
does not cancel Claude. `/detach`, terminal EOF, and termination signals leave
remote work running. `/exit`, `/quit`, and idle Ctrl+C/Ctrl+D explicitly stop it.

Rerun `juiced claude` in the same terminal tab, project directory, and workspace
to reconnect to that tab's session. The first launch starts a new session;
`juiced claude --new [Claude arguments...]` replaces its binding with a fresh
one. Resumption recovers live work, saved output, and conversation context through
the existing durable session protocol, including after an explicit `/exit` has
stopped the remote process.
Reattachment prints saved prompts, responses, and tool activity into terminal
scrollback, including output from a turn that is still running. New output then
continues below that history; restoring the display does not submit a prompt or
answer a pending permission request.
Supplying Claude arguments starts a fresh bound session so launch settings and
initial prompts take effect; reattachment retains its saved launch configuration.

Run `juiced claude sessions` to list saved remote conversations in this project
and workspace, newest first, with their Juiced IDs and last update times (UTC).
Listing does not start Claude, require Claude login, sync files, or modify
conversation histories. It inspects an existing workspace and does not provision
a missing one. It includes older conversations after a tab starts fresh with
`--new`; it is not limited to the tab bindings stored locally. Git sessions are
scoped to the same repository binding and relative launch directory used when
reopening. Native passthrough sessions are excluded.

Use `juiced claude --session ses_<id>` from any tab in the same project and
workspace to reopen a specific session using the ID displayed in its header.
This option bypasses the terminal binding, as do explicit Claude
session-selection flags, disabled native persistence, and native passthrough.

The local `.cantelop/juiced/` directory stores only session identities. Tab
bindings are keyed by terminal identity and canonical workspace ID inside the
local project, so a different tab or recreated workspace starts fresh. The
terminal identity comes from a terminal session ID, tmux/screen pane ID, or the
parent shell's PID and start time; a reused TTY device alone is never a key.
Without an available identity Juiced reports that automatic resume is disabled.
Bindings are saved atomically after first-launch Git preparation succeeds.
Automatic reconnect uses only tab bindings.
Resume does not refresh or transfer the Git checkout. File transfer remains an
explicit command.

The runtime saves each Juiced ID in `identity.json` beside its hashed journal.
Older runtimes saved only the hash. Listing can recover those IDs from matching
local tab bindings; it reports the number of older histories whose IDs remain
unknown. Reopening an older session from its original tab or with its known ID
saves its identity for future discovery. Unreadable histories are counted in the
listing. Build and deploy matching CLI and runtime sources to enable listing.

## Runtime lifetime

The headless process is supervised by a Cantelop activity with a 24-hour deadline.
No client heartbeat extends it. Cantelop's own dispatcher protects active work
with server-side leases and drains output without a connected TUI. After two
minutes without a turn or control request, Juiced ends idle native stdin. The
activity settles, allowing the sandbox's existing 120-second idle policy to run.
The next prompt or menu request starts Claude with the same native conversation
ID and its saved transcript. An unavailable saved transcript fails explicitly.

The existing SDK Claude runner has a bounded public conversation projection and
does not expose Juiced's complete native menu and approval control protocol.
Juiced therefore keeps that protocol and uses the same persistence-before-
publication ordering around its terminal adapter. This implementation does not
change Cantelop or the SDK. Native passthrough retains its existing lease policy.

## Durable output and reconnect

Each logical session owns an append-only journal under
`/workspace/.juiced/sessions/<hash-of-session-id>/events.jsonl`. Records include
complete native JSON observations, displayed user messages, process boundaries,
input receipts, and turn state. User messages and native output are separate
record types, so input cannot splice a partially read native JSON frame.
The first text delta after a message/block boundary is committed immediately.
Following text deltas are coalesced for at most 25 ms before being committed. Completed
observations are committed before publication. Neither the journal nor its
paginated replay truncates response text or drops old turns.

Appends handle short writes and fsync before acknowledgment. A native output
batch shares one fsync across its bounded journal records. Creation syncs the
directory chain. Replacement scans records, rebuilds a byte-offset index, and
discards an incomplete final append. A malformed complete record fails instead
of silently skipping history. Replay replies stay below the platform's 64 KiB
reply limit and read records by file offset rather than keeping transcripts in
memory. Journals currently remain until workspace deletion.

Live SSE output drains from the journal with at most twelve events awaiting
collector acknowledgment. A stalled collector leaves the backlog on disk;
it does not drop intermediate notifications or retain the transcript in memory.
One coalesced view handoff follows its enqueued event sequence independently,
so its acknowledgment cannot block new output from filling available slots.
Failed output handoffs retry from the acknowledged prefix; clients deduplicate
by journal sequence. The CLI resolves the workspace once and uses its ID for
subsequent session commands, avoiding a slug lookup on every submission.

Reattachment subscribes at the view boundary and dispatches one replay
command. The runtime streams a fixed journal snapshot in bounded pages over the
same subscription, pipelining up to twelve pages per durable handoff batch. This
avoids a separate command round trip for every 48 KiB of history. Replay IDs
isolate concurrent readers, and an explicit end marker confirms completeness.
New output interleaved with recovery is reconciled by journal sequence; any
remaining gap starts another snapshot from the last recovered entry. Interrupted
transfers and expired/reset transport cursors resume there without repeating
displayed frames. Replay advances the saved transport boundary between batches
so large histories can exceed transport retention. Legacy paginated request
replies remain available for diagnostics. A 30-second read watchdog reconnects
half-open subscriptions after sleep. View/subscription
reads do not keep compute alive; while a turn is working, a watchdog also checks
the journal so sandbox loss can be reported.
The streamed protocol requires rebuilding the CLI and deploying its matching
runtime together; existing journals remain readable.

## Input and permissions

Each input frame has an application identity, native process epoch, and stable
SDK request identity. Before handing it to native stdin, the runtime persists
its identity and payload fingerprint. A successful handoff is recorded before
the reply. Retrying a recorded handoff does not write it again; an identity with
a different payload is rejected. A request for an older process epoch is also
rejected.

Process loss between the attempt record and handoff confirmation is ambiguous.
Juiced reports interruption and does not resubmit that input automatically.
This avoids repeating tools or permissions whose effects may already exist.
Recovery is conversation resumption, not process-memory checkpointing.

Permission requests and their answers are journaled. Reattachment reconstructs
pending requests while a process is still alive. A process boundary clears old
requests. Restoring a screen does not answer an approval or submit a prompt.
Draft editing remains local; unsubmitted drafts survive network interruptions
in the same TUI, but not a CLI restart.

## Verification

`test/durable-agent.test.ts` exercises output beyond the transport replay window,
streamed history, interrupted transfers, interleaved live output, duplicate and
ambiguous input acknowledgments, expired cursors, reattachment with pending
approvals, immediate leading deltas, short text batches, bounded output under
stalled acknowledgments, failed handoff retries, idle native resumption, partial append
repair, and recovery of uncertain input after runtime replacement.
`test/runtime-protocol.test.ts` additionally runs durable commands through the
actual SDK activity handler and a real native JSON subprocess, including a
streamed replay larger than the SDK output buffer while native work stays alive.
Renderer tests
verify local editing while connectivity is stalled and detachment on terminal
loss. Hosted sleep/wake verification still requires a matching runtime deployment.

For hosted latency diagnosis, run `JUICED_DEBUG=1 juiced claude` in the original
terminal tab after building and deploying matching sources, or use
`JUICED_DEBUG=1 juiced claude --session ID` for a specific session. Diagnostic
records include view read time, time to the first stream event, replay first-chunk/completion time and
chunk/entry counts, and existing command acknowledgment timings. These records
contain timing and sequence metadata rather than transcript contents. Elapsed
durations use the client clock; they do not isolate network RTT or backend time.
Compare fresh output and command acknowledgment separately from history replay.

An eight-sample local comparison against `0dc9c14` measured median leading-delta
delivery at 258 ms before these changes and 10 ms afterward; subsequent batched
deltas measured 259 ms and 33 ms. The fixture measures the native output callback
through journal fsync to a `RemoteAgent` frame with immediate mocked collector
acknowledgments. It excludes the public network and is not a hosted latency SLA.


Hosted measurements on October 20, 2026 used release v17, runtime code commit
`2b547a1`, the original history session, and a separate disposable control session.
The history now contains 1,838 entries and 3,100,500 serialized replay bytes. It
restored through one command and 68 streamed chunks per run:

| Measurement | Median | Observed range | Samples |
| --- | --- | --- | --- |
| Full history replay, including stream setup | 1,532 ms | 1,492–2,088 ms | 3 |
| History replay plus its preceding view read | 1,816 ms | 1,728–2,362 ms | 3 |
| Warm sequential request acknowledgment, workspace ID | 377 ms | 363–424 ms | 12 |
| Warm sequential request acknowledgment, workspace slug | 414 ms | 376–438 ms | 12 |
| Native control response arriving over SSE | 341 ms | 318–516 ms | 12 |
| Lightweight authenticated origin read | 236 ms | 216–275 ms | 6 |

Successive history chunks arrived 10 ms apart at the median and 55 ms apart at
p95. These chunk spacings measure replay throughput, not fresh request latency.
The earlier paginated restore took 39,161 ms after the dispatcher fix; the original
user report was 139 seconds. The current history has gained a small number of
records, so byte counts differ slightly. Standalone request samples return empty
history pages while native work stays alive. Control-response timings include
native control handling, journaling and the transport path, with no model
inference. A lightweight origin read includes Edge, routing and database work;
it does not isolate physical RTT. Fresh requests remain above 100 ms on the
measured route. Small sample sizes limit percentile conclusions. Full handshake
and process startup are excluded from the standalone replay timings.

The measurement created no model prompts and did not stop the existing history
session. See [the timing samples](../diagnostics/streaming-latency-2026-10-20.json).
