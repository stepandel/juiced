# First-read latency investigation, October 23, 2026

Below two seconds is a plausible combined target, but it has not been
demonstrated. SDK round-trip removal alone is insufficient. A deliberately
fresh inspection session took 3,473 ms, including a 262 ms sign-in refresh;
removing that measured request leaves an approximate 3,211 ms remainder.
These probe totals exclude the launcher and Node startup.

## Measurements and cold-state boundaries

The production CLI, Fleet package and Juiced service remained on 0.3.2.
No platform deployment, SDK release, model prompt or project upload was made.

| Read | Total | Workspace request | Inventory request | Git snapshot |
| --- | ---: | ---: | ---: | ---: |
| First after 0.3.2 rollout, earlier evidence | 3,261 ms | 1,287 ms | 1,597 ms | 643 ms |
| First command after a gap | 2,293 ms | 1,100 ms | 854 ms | 259 ms |
| Immediate repeat | 1,478 ms | 424 ms | 746 ms | 134 ms |
| Deliberately fresh inspection session | 3,473 ms | 1,099 ms | 1,735 ms | 701 ms |

The 2,293 ms read used a Sandbox allocated before that command, so it does
not establish cold-Sandbox latency. The deliberate probe replaced only the
inspection Session ID with a random ID and set keep-alive to zero. Its trace
confirmed a new Sandbox binding during the request. The isolated Session was
stopped after measurement. Host filesystem and backend caches were not reset.
Every probe rendered the comparison with HTTP 200 throughout; exit 2 denotes
the existing ignored-entry comparison.

The fresh inventory's 1,425 ms platform span breaks down as follows. These
segments are consecutive and exclude the surrounding Fleet and client calls.

| Segment | Duration |
| --- | ---: |
| Edge ingress through durable message acceptance | 148 ms |
| Acceptance to queue claim | 46 ms |
| Queue claim through Sandbox binding | 344 ms |
| Binding to handler start | 46 ms |
| Handler, including 701 ms Git snapshot | 716 ms |
| Handler completion through Edge response | 125 ms |

SDK mailbox wait was approximately 1.3 ms. Increasing intake concurrency or
lowering a mailbox polling timer does not address the dominant measured costs.
The 344 ms binding segment contains several operations, including session
activation, route lookup, capability inspection and lease/persistence work;
it is not an isolated VM boot measurement.

## Concrete SDK opportunities

`../cantelop-sdk/src/fleet.ts` resolves status before requesting credentials
on every `connection()` or `app()` call. Juiced resolves a connection for each
of its two runtime relay requests. The credentials route in
`../cantelop/console/web/app/v1/fleets/[[...path]]/route.ts` already reads the
installation before returning its App/runtime metadata.

Direct reads from this computer measured the two-call SDK connection at
330 / 223 / 252 ms and the credentials endpoint alone at 114 / 138 / 115 ms.
These establish an avoidable serial request, not production end-to-end savings:
the earlier Vercel spans for both connection resolutions together were only
277 ms. A coordinated connection response must retain instance selector,
ownership, credential and compiled-runtime validation, including rejection
before incompatible App access. Returning credentials alone and silently
dropping those checks is not the proposed change.

The generated protocol Worker also retains a webhook-side `App` constructor
when no webhooks exist. Its dependency chain is
`protocol-edge -> App -> transport -> database -> @libsql/client/web`.
Juiced declares auth and environment configuration but no webhooks or homepage.
A local command-only prototype omitted that constructor and removed libSQL:

| Same SDK factory entry | Bundle bytes |
| --- | ---: |
| Current factory | 222,287 |
| Command-only research prototype | 39,036 |

Workspace inspection and request routing, invalid authentication, command/path
mismatch and missing Fleet capability checks passed for both variants. This
is a feasibility experiment, not a production patch or a hosted speedup.
Production code must select the smaller adapter only for Apps without webhook
or homepage declarations, and retain the complete adapter otherwise.

## Platform cold path

`../cantelop/edge/workers/dispatcher/src/fleet-runner.ts` obtains code through
WorkerLoader. On a loader miss it reads immutable package chunks from a Durable
Object, validates and hashes the module, and provides code and bindings to the
Worker loader. Release-gate checks and invocation-specific capabilities remain
required. Metadata reads traverse this path too.

The complete first Edge metadata lookup measured 608–891 ms across these
samples, while repeat lookups measured 143–164 ms. Package loading and isolate
initialization are candidates for that difference, but existing spans do not
isolate their contribution from the gate, broker and host lookup. Add stage
timings before claiming a particular number of milliseconds from a smaller
Worker or an immutable package cache.

`../cantelop/fire-fuse/runtime/supervisor/start.go` takes a prepared host slot
but still launches Firecracker, loads and resumes the snapshot, assigns the
guest, mounts its workload/workspace and waits for startup. The fresh-delivery
and completion-notification paths already avoid an unconditional one-second
polling delay. Activation optimization needs its existing warmup phase timings;
the measured binding segment does not identify which phase to remove.

The 643–701 ms fresh Git captures versus 130–202 ms repeats also need individual
Git-command and filesystem timings. Executable/page-cache initialization,
metadata operations and content reads have not been separated. Inspection
currently performs several Git subprocesses and before/after consistency
checks; preserve live-read and private-index semantics when consolidating work.

## Recommended implementation sequence

1. Ship the smaller command-only SDK Edge build and add loader/gate/broker stage
   timings, then measure new package/isolate and fresh-Sandbox reads separately.
2. Add a single, validated Fleet connection response and use it in the SDK.
3. Combine Juiced bootstrap, existing-Workspace resolution and inspection into
   one backend operation, reusing its verified connection. Preserve CLI/runtime
   negotiation, canonical Workspace identity and missing-Workspace behavior.
4. Use activation and per-Git-operation spans to reduce the remaining cold
   work. Benchmark full installed commands with fresh inspection sessions,
   recording sign-in refresh separately, before claiming a sub-two-second result.

Do not add the whole cold workspace request as removable time: package/isolate
initialization may move to the inventory request when that request becomes
first. The fresh case needs roughly 1.2–1.5 seconds of improvement, plus any
launcher cost; the easy Fleet request removal is only one part of that budget.

The sibling checkouts were preserved. Platform source was inspected at
`4c7c8ababb43d1755d6c51383f0cf5ce6c7b3584`; the SDK working checkout was
`b65bf304527111f5a2d2d787d21d3e86ca1266b1` with existing uncommitted work.
The released 1.6.0 checkout (`30f2ae8`) and installed package were used for
the SDK probes. Sanitized timings, exact trace identities, prototype sizes
and limitations are in
`diagnostics/peek-cold-read-feasibility-2026-10-23.json`.
