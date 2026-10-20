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

Use `juiced --resume claude` from any tab in the same project and workspace to
reopen the last session, or `juiced --session ses_<id> claude` to select one
explicitly. These options bypass the terminal binding, as do explicit Claude
session-selection flags, disabled native persistence, and native passthrough.

The local `.cantelop/juiced/` directory stores only session identities. Tab
bindings are keyed by terminal identity and canonical workspace ID inside the
local project, so a different tab or recreated workspace starts fresh. The
terminal identity comes from a terminal session ID, tmux/screen pane ID, or the
parent shell's PID and start time; a reused TTY device alone is never a key.
Without an available identity Juiced reports that automatic resume is disabled.
Bindings are saved atomically after first-launch Git preparation succeeds.
Resume does not refresh or transfer the Git checkout. File transfer remains an
explicit command.

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
Text deltas are coalesced for at most 250 ms before being committed. Completed
observations are committed before publication. Neither the journal nor its
paginated replay truncates response text or drops old turns.

Appends handle short writes and fsync before acknowledgment. Creation syncs the
directory chain. Replacement scans records, rebuilds a byte-offset index, and
discards an incomplete final append. A malformed complete record fails instead
of silently skipping history. Replay replies stay below the platform's 64 KiB
reply limit and read records by file offset rather than keeping transcripts in
memory. Journals currently remain until workspace deletion.

SSE notifications carry journal sequence numbers and may coalesce under output
backpressure. The runtime commits a small Cantelop view with the published
sequence. Reattachment subscribes at that boundary and dispatches one replay
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
approvals, idle native resumption, partial append
repair, and recovery of uncertain input after runtime replacement.
`test/runtime-protocol.test.ts` additionally runs durable commands through the
actual SDK activity handler and a real native JSON subprocess, including a
streamed replay larger than the SDK output buffer while native work stays alive.
Renderer tests
verify local editing while connectivity is stalled and detachment on terminal
loss. Hosted sleep/wake verification still requires a matching runtime deployment.
