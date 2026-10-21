# Managed multitenancy implementation plan

Status: implemented across the Juiced, Cantelop and SDK feature branches,
2026-10-20. Deployment and paid-launch qualification remain gated on external
configuration and real-host evidence. See [operations and remaining gates](managed-service.md).
Architectural context is in [the proposal](multitenancy.md).

## Product decisions and scope

Confirmed decisions:

- Juiced manages infrastructure and billing. End users need no Cantelop account.
- One Cantelop App per Juiced account; one personal account per user initially.
  Projects remain Workspaces; conversations remain Sessions.
- GitHub and Google sign-in in the first production release.
- Accounts start free with workspace compute included. Future subscriptions may
  include a fixed usage allowance with a hard cap and no automatic overage
  charges. Prices and included quantities are configuration, to be chosen before
  paid launch.

V1 includes account/device management, isolated provisioning, the existing Claude
and Git workflows, metering, enforced allowances, billing, upgrades, deletion,
and an installable CLI. Team invitations, enterprise SSO, multi-region placement,
direct Edge delegation, and multiple concurrent runtime versions within one App
are later extensions. Model access continues through the user's existing Claude
login; the Juiced subscription covers infrastructure, not a new model-token plan.

Launch free accounts with per-App resource limits and verified isolation and
recovery. Qualify subscription billing separately before introducing paid plans.
Billing is never represented as implemented by an entitlement stub.

## System layout and ownership

Keep Juiced's application backend in this repository, separate from Cantelop's
generic platform code. Preserve the root CLI package and add private npm
workspaces under `service/` and `contracts/`; this avoids relocating the existing
runtime graph during the tenancy change. Ship only CLI assets and required
runtime dependencies in the public npm package. Deploy service code separately.

Recommended implementation defaults, subject to the feasibility checks below:

| Component | Implementation | Responsibility |
| --- | --- | --- |
| Juiced API and web pages | TypeScript, Node.js, Hono; small browser UI for sign-in/device approval, billing, devices, usage, deletion | Identity, account authorization, CLI bootstrap, streaming relay |
| Juiced jobs | Separate entry point/process from the API, same codebase | Provisioning reconciliation, entitlements, usage ingestion, upgrades, deletion |
| Juiced persistence | PostgreSQL and Drizzle; database-backed outbox/jobs with leases | Account mapping, durable operations, billing and usage projections |
| Browser/CLI authentication | Better Auth, GitHub/Google, OAuth Provider and device authorization | Maintained protocol implementation, rotating device grants, sessions and signing keys |
| Payment collection | Stripe-hosted Checkout and customer portal | Subscription payment and customer payment management |
| Cantelop console/control workers | Existing PostgreSQL, TypeScript workers and public control API | Fleet principals, packages/installations, policies, infrastructure usage |
| Cantelop compute/storage | Existing Fire Fuse/dispatcher and storage providers | App-scoped admission, usage evidence, enforced execution/storage limits |
| SDK | Existing typed App and `AppConnection` | Runtime protocol and custom managed transport |

Deploy the Juiced API as a long-running service in the compute region with TLS,
bounded uploads, and streaming support. Provisioning jobs get infrastructure
administration permissions; relay instances get only fleet installation lookup
and per-App runtime credentials. Keep production/staging databases and secrets
separate. The exact domain and hosting account are deployment inputs, not hardcoded
assumptions. Do not place OAuth client secrets or billing keys in the CLI.

Better Auth documents both [Hono integration](https://better-auth.com/docs/integrations/hono)
and [scoped OAuth device authorization](https://better-auth.com/docs/plugins/device-authorization).
Use its OAuth access/refresh-token path for the CLI, not a raw browser-session
token. Hono exposes [stream piping and abort handling](https://hono.dev/docs/helpers/streaming).
Pin and qualify compatible versions during the first milestone.

## Contracts to establish first

### Identity and device lifecycle

Use the device authorization grant for both desktop and remote CLI login. Open
the approval page automatically on desktop and print the URL/code in all cases;
`juiced login --no-browser` supports remote shells. This chooses one V1 path from
the alternatives in the proposal. A loopback authorization-code/PKCE path can
be added later if the device experience warrants it.

Use an administrator-registered public client with no embedded secret, a fixed
Juiced API audience, and only first-party required grants/scopes. Disable public
client registration. Require explicit browser approval of the displayed device
code and account. Implement polling interval, slowdown, denial, expiry, and
cancellation behavior through the provider. This follows the
[device authorization standard](https://www.rfc-editor.org/rfc/rfc8628.html).

Initial tunable defaults: five-minute access tokens, 30-day maximum device grants,
short-lived approval codes, and revocation of requests/streams within 30 seconds.
The auth spike must prove stable grant/session identification, refresh rotation,
replay handling, and server-side revocation. Serialize refresh across CLI processes
with an OS lock and atomic credential replacement; do not invalidate legitimate
concurrent clients through a refresh race or retry an ambiguously consumed refresh
credential blindly. Use the OS credential store, with a documented `0600` fallback.

The provider owns its auth tables. Juiced adds account memberships and device
metadata keyed to provider user/grant IDs. Do not maintain a second OAuth token
issuer or duplicate the provider's refresh-token implementation. Link Google and
GitHub identities only through an authenticated linking flow; a matching untrusted
email is not sufficient. GitHub sign-in grants identity access, not repository
write access: retain explicit `github-configure` for the remote `GH_TOKEN`.

### CLI command and configuration contract

Published releases default to managed mode. Add `juiced login [--no-browser]`,
`juiced logout [--all]`, and `juiced whoami`. A leading `--account ID` selects an
authorized account; preserve existing `--workspace` and Claude command meanings.
`juiced --self-managed ...` or `JUICED_MODE=self-managed` explicitly selects the
existing Cantelop-profile path. Unknown modes/ambiguous selectors fail early.
Managed mode never reads an ambient Cantelop profile as an authentication fallback.

Store service origin/environment, selected account and device grant separately
from project-local state. Credentials are keyed by canonical service origin;
switching a development/staging endpoint cannot send production credentials there.
Only explicit development configuration permits loopback HTTP. Bootstrap returns
an opaque installation ID, runtime/CLI compatibility, entitlement and operation
status. It returns no infrastructure credentials.

Normal interactive startup can guide the user to account login and show durable
provisioning progress; piped commands fail with actionable login/pending/upgrade
errors. Local help and Juiced version remain offline. Logout requires successful
server revocation to report remote sign-out complete; offline removal of local
credentials must explain that remote revocation is still pending.

Scope terminal bindings, import refs and publication receipts by a versioned hash
of canonical service origin, account, installation, Workspace and local project.
Migrate legacy bindings only after an explicit verified target selection. Keep
file-sync's single-local-directory lock, and refuse automatic repair/re-pairing
when its canonical target differs. Add a managed context/stop callback to the
existing Git session wrapper rather than exporting a generic database proxy.

### Juiced API

All route names below are proposed contracts to implement and document together
with their clients. Account IDs are opaque, membership-checked selectors. Client
tokens identify the user/device grant; the API rechecks membership and account
status rather than trusting a stale account claim in a token.

| Route | Contract |
| --- | --- |
| `/api/auth/*`, `/sign-in`, `/device` | Provider-owned protocol endpoints plus sign-in and explicit device approval UI |
| `GET /v1/me` | User, authorized accounts, current device; no infrastructure credentials |
| `POST /v1/accounts/{account}/bootstrap` | Idempotently ensure an entitled installation; accept CLI version and compiled runtime identity; return ready metadata or an operation |
| `GET /v1/accounts/{account}/installation` | Desired/observed state, installed runtime, minimum supported CLI, actionable status |
| `GET /v1/accounts/{account}/operations/{operation}` | Durable progress/error and retryability, scoped to the account |
| `GET /v1/devices`, `DELETE /v1/devices/{device}` | Device listing and revocation; ownership required |
| `POST /v1/logout` | Revoke current device grant; optionally revoke all explicitly |
| `ANY /v1/accounts/{account}/runtime/*` | Exact allowlisted SDK routes, not an arbitrary HTTP proxy |
| `POST /v1/accounts/{account}/git-sessions/{session}/stop` | Typed Workspace/project/session stop and checkout-lease cleanup; no caller SQL |
| `GET /v1/accounts/{account}/usage` | Included, settled, reserved, available usage, period end and storage quota |
| `POST /v1/accounts/{account}/billing/checkout`, `POST .../billing/portal` | Membership-checked hosted billing links; server selects allowed prices |
| `POST /webhooks/stripe` | Signature-verified, durable event inbox; acknowledge after persistence |
| `POST /v1/accounts/{account}/deletion` | Recent browser authentication, explicit confirmation and durable deletion operation |

Use an OpenAPI/schema source in `contracts/` with shared error definitions and
client types. Bootstrap and lifecycle writes accept an idempotency key, retained
long enough for recovery. Reuse with a different body returns a conflict. Responses
include request/operation IDs and `Retry-After` where relevant. Use named errors
such as `not_signed_in`, `installation_pending`, `subscription_required`,
`usage_limit_reached`, `account_suspended`, and `cli_upgrade_required`. Keep SDK
upstream errors intact inside the runtime relay so existing recovery logic works.

### Relay and credential boundaries

Capture `(service environment, account ID, installation ID)` once at command
start. Bootstrap compatibility first; all later calls and automatic reconnects
retain that binding. Derive the target App/Edge origin on the server from its
installation record. Send the pinned installation ID as a checked Juiced protocol
header on runtime calls; validate its account membership and immutable App binding.
If the account's installation is replaced/deleted, return `installation_changed`
and require an explicit new command instead of rerouting the in-flight operation.
Strip caller Authorization, cookies, forwarding headers,
and infrastructure routing headers; attach the App token server-side. Permit
the pinned runtime compatibility header only after validation. Never follow
redirects with credentials.

Maintain a checked protocol fixture for the pinned SDK's relay allowlist and
verify it in cross-repository contracts. Do not deep-import unpublished SDK
internals or silently permit new operations after a dependency update.

SDK 1.4.0 already routes environment updates through
`/commands/app.environment.{set,unset,status}` and the same `AppConnection`.
Relay those validated commands with account-level permissions; do not duplicate
environment mutation APIs merely to support multitenancy. The allowed transport
surface is:

| Surface | Enforcement |
| --- | --- |
| `POST /commands/{known-command}` | Known protocol version, exact command/path agreement, bounded JSON envelope (currently 1 MiB), checked resource ownership |
| `/__cantelop/sync/workspaces/{canonical-id}` | Exact known methods/query schema; canonical Workspace belongs to installed App; stream bounded binary bodies (currently 16 MiB per file) |
| SSE responses | Pipe bytes and preserve cursor/events; cancel upstream on detach, expiry, revocation or shutdown; no response buffering |
| Native auth terminal | Only issue authorized App/Workspace tickets; record device/terminal association; expiry, single use and explicit closure on revocation |
| Workspace database credentials | Denied for managed CLI traffic; available only to trusted backend/runtime code |

Git transfers currently allow 512 MiB aggregate but use bounded protocol chunks;
the relay must not allocate that whole transfer in memory. Preserve original
message identities across authorization refresh/retry. Retry only requests whose
semantics permit it; SDK environment updates can create another revision when
replayed, so do not blindly replay a mutation after a transport failure. Forward
response status, content type, SDK error shape, aborts, and backpressure.

There is a concrete direct-database path to remove from managed mode:
`createGitSession()` in `src/git-workspace.ts` reads checkout lease tokens through
`workspace.database()`, stops the Session, then deletes only those tokens. Cantelop
currently issues database credentials for about 15 minutes. Move this operation
to the typed service endpoint, maintaining snapshot-before-stop and compare-token
cleanup so a new attachment's leases survive. Preserve the existing direct path
for explicit self-managed mode. Managed clients receive neither App integration
tokens nor provider database credentials. Runtime database access remains private
and Workspace-bound.

The pinned route list must include an authorization matrix: owner-only account
configuration, workload mutations requiring runtime entitlement, passive reads,
and always-available safe stop/cancel/device revocation/deletion. A nominal read
that starts a Sandbox consumes allowance; inspection, Git maintenance, and auth
cannot become unmetered compute bypasses. Drain/close issued terminal tickets
on revocation within the published bound. Relay logs contain metadata only.

### Cantelop fleet API and machine principals

Introduce a Fleet belonging to the Juiced operator's existing Cantelop owner.
Apps remain owned by that owner; a Fleet scopes automation and package access.
Service principals are separate actors with a fixed owner/Fleet and explicit
scopes, not a new way to impersonate a human or select an arbitrary owner ID.
Keep existing human-authenticated `/v1` behavior intact.

| Proposed control route | Scope and semantics |
| --- | --- |
| Owner management of Fleet/service credentials | Existing authenticated owner creates/revokes principals; secret returned once, hashed at rest |
| `POST /v1/fleets/{fleet}/packages` | Publisher registers an immutable artifact pair from an authorized publisher App release |
| `GET /v1/fleets/{fleet}/packages/{package}` | Installer reads authorized package metadata and compatibility, without provider secrets |
| `PUT /v1/fleets/{fleet}/installations/{external-key}` | Create-or-read one target App and pinned initial package under a stable opaque key |
| `GET /v1/fleets/{fleet}/installations/{installation}` | Target App, runtime, release/operation states and observed policy revision |
| `POST /v1/fleets/{fleet}/installations/{installation}/releases` | Explicit idempotent upgrade/rollback to an authorized immutable package |
| `PUT /v1/fleets/{fleet}/installations/{installation}/policy` | Compare-and-set desired entitlement/limits; return operation/revision and enforcement status |
| `GET /v1/fleets/{fleet}/usage?after=cursor` | Paginated durable usage events with replayable cursor, not dashboard readings |
| Installation runtime credential read/rotation | Runtime-credential scope; only Apps bound to that Fleet; never list another owner's credentials |
| Installation deletion/status | Close admission, stop work, purge durable state, archive App, report observed completion |

Scopes distinguish publisher, installer/lifecycle worker, relay credential reader,
policy writer, and usage reader. Separate credentials per process/environment;
rotate with bounded overlap and audit principal, target, operation and result.
No service principal can change owner quotas, invite collaborators, or inspect
unrelated operator Apps. Do not accept a billing owner from an untrusted request.

### Published artifacts and installations

Use an immutable package record containing publisher/Fleet, logical name
`juiced`, version, Edge/runtime digests and manifests, runtime ID, supported
protocol/CLI range, state-schema compatibility, and provenance. Register a package
only after verifying an authorized release and artifact pair. Publishing the same
version with different content is a conflict. Disabling a package prevents new
installs without making existing retained artifacts disappear.

For normal source deployments, keep today's manifest-name/target-slug validation.
For package installations, validate a durable package-to-target binding and its
logical name instead. Build the logical `juiced` definition once; opaque target
slugs do not change its fingerprint. Preserve matching compiled runtime IDs at
CLI, Edge, and Sandbox. Qualify webhook, environment, native auth, database
schema and runtime startup behavior under the logical/physical name separation.

Create the target App and installation association in the same quota-checked
transaction. Generate a unique opaque slug from a stored random identity. Reuse
existing release components/operations and reconciliation; do not build a second
deployment engine. Each App receives fresh integration secrets, independent
configuration and release state. Retain shared immutable artifact references
across package versions, installs, failed operations and rollback windows.
No source App secrets or mutable Workspace data are copied.

### Hard caps, usage and resource enforcement

Define the allowance in integer infrastructure credits using a versioned rate
card for allocated vCPU-seconds and GiB-seconds. Warm allocated idle time counts;
shared unallocated warm-pool capacity is operator overhead. Include auth and
maintenance Sandboxes in resource accounting. Choose customer-facing units and
quantities before paid launch; expose the same calculation in the usage page.
Live CPU/RSS readings remain observability, not the billing source of truth.

Enforce separate limits for active Sandboxes, vCPU/memory, Workspace count,
durable bytes/inodes, database size/requests, transfer/egress, request rates, and
fleet capacity. Resource quotas, included compute credits and currency charged
are distinct. Usage exhaustion cannot create usage-overage charges or switch the
account to pay-as-you-go billing.

Use prepaid runtime reservations, with this invariant:

```text
available = included + explicit adjustments - settled usage - outstanding reservations
available >= 0
```

Cantelop owns authoritative reservation/usage records and enforces them on the
compute path; Juiced consumes a projection for UI and billing reconciliation.
The control worker allocates a bounded credit lease to a particular App/host,
policy revision, rate card and expiry, and projects it through authenticated
private provider commands. The host atomically assigns portions to allocations
before starting or extending them. No allocation can outlive its prepaid portion
or the host lease. Renewals reserve additional allowance first. Unused allowance
is released only after authoritative finalization; a lost host cannot make its
outstanding reservation available to another host concurrently.

Initial feasibility target: at most 60 seconds of leased execution with explicit
shutdown headroom included in the reservation. Enforce expiry below the agent
process, including detached native subprocesses. Clock/restart handling must not
extend leases; boot identity and durable reservation fencing prevent replay.
Apply this to dispatch, retries, auth/maintenance, idle keep-alive, recovery and
Sandbox replacement. When exhausted, close admission and stop work with a durable
interruption reason. Do not automatically resubmit the interrupted turn.

Use the existing control-to-compute projection boundary; do not expose private
Fire Fuse APIs or give it billing-provider credentials. A control worker renews
leases from durable active-allocation/usage observations. If the controller is
unavailable, paid leases expire safely; available-budget reads do not authorize
unbounded offline work. If exact hard-stop enforcement cannot be demonstrated,
do not advertise a hard compute cap.

Usage events originate in a durable host outbox, with stable allocation identity,
incarnation/sequence, App/Workspace/Session, interval, shape, rate-card and
reservation references. Record start/end and periodic interval evidence, including
crash recovery. Ingest into a deduplicated platform ledger before acknowledging
the outbox. Provide a stable cursor to Juiced; it atomically saves event IDs and
its checkpoint. Reconcile missing final intervals conservatively against reserved
allowance and apply explicit corrections rather than double charging.

Enforce storage quotas at the actual filesystem/database boundary, including
native Claude tools, not only SDK uploads. The feasibility spike must prove
Workspace quotas plus an aggregate App allowance; partition an App's allowance
into bounded Workspace grants if necessary. A depleted compute allowance leaves
data within the storage quota, with passive access and safe cleanup available.
Storage retention after cancellation is a separate published policy; retained
bytes do not vanish when compute stops.

## Persistence and state transitions

Start from the complete service and authentication schema in
`service/migrations/0001-initial.sql`. After the first deployment, add reviewed
forward migrations without altering released migrations. Use foreign keys,
unique constraints and compare-and-set revisions rather than slug lookup as an
ownership mechanism.

| Database | New record groups and key constraints |
| --- | --- |
| Cantelop PostgreSQL | Fleets; service principals and credential digests; immutable packages/artifact references; installations unique by Fleet/external key and target App; policy revisions; budget periods/reservations; deduplicated usage ledger/outbox; audit events |
| Fire Fuse durable state | Managed-App policy revisions; fenced host/allocation credit leases; enforced deadlines; usage outbox and checkpoints; additive state compatibility migrations |
| Juiced PostgreSQL | Provider auth tables; accounts; memberships; device/grant metadata; installation unique by account/environment and App; durable jobs/operations/outbox; subscription/customer mapping; verified billing-event inbox; usage projection/checkpoint; audit events |

Create a personal account/membership idempotently on verified first sign-in.
Persist the installation intent before network calls. Derive a stable opaque
external installation key from that intent, not a device, email or directory.
Workers claim jobs with a lease/fencing token, use external idempotency keys,
commit observed results, and retry with bounded backoff. Never hold a database
transaction across a provider call. A lost response reconciles through the stable
installation key; it does not create another App.

Keep account entitlement separate from installation health:

```text
installation: pending -> provisioning -> ready
                           |             |
                           v             v
                         failed       updating -> ready / failed
any non-deleted state -> deleting -> deleted

account entitlement: inactive / active / exhausted / suspended / deleting
policy: desired revision -> projected revision -> enforced revision
```

Failure stores the operation/step, sanitized code and retryability. An upgrade
failure records whether the previous release remains usable. A ready installation
requires an active compatible release, usable credentials and enforced policy;
an App row alone is not readiness. Never report suspension/deletion as completed
solely because the desired state was saved.

## Reviewable implementation sequence

The IDs below are units of work, not created pull requests. Each unit should
land with its migrations, contract changes, tests and operational notes. Resolve
the dependency gates before starting dependent implementation.

| ID | Repository / work | Dependencies | Acceptance evidence |
| --- | --- | --- | --- |
| P00 | All: establish source/package baseline and contract fixtures | None | Pin compatible Cantelop, SDK and Juiced revisions; installed SDK 1.4.0 environment behavior matches the chosen source baseline |
| P01 | Juiced/Cantelop: feasibility harness for auth, relay, release binding, leases and storage quotas | P00 | Two-App fixture; real device grant/revocation; SSE and file streaming; same artifact installed with distinct names; host deadline and native-write quota proof |
| C01 | Cantelop: Fleet records, machine principals, scoped auth, audit and rotation | P01 contracts | Allowed Fleet operations work; other Fleet/owner Apps, human admin actions and revoked credentials are denied |
| C02 | Cantelop: immutable packages and artifact retention | C01 | Verified publisher release registered once; conflicting publish denied; referenced blobs survive source archival/cleanup |
| C03 | Cantelop: idempotent installation and package-bound deployment | C02 | Concurrent/retried creation yields one App; two installs share code but have different credentials/data; ordinary source name checks still apply |
| C04 | Cantelop: App resource policies and enforced suspend/stop/purge lifecycle | C03 | Policy revision observed at host; per-App admission and native-write quotas enforced; deleting App data is distinguishable from archival |
| J01 | Juiced: service/workspace scaffolding, DB migrations, contracts, jobs/outbox | P01 | Fresh install and migration/restore smoke test; API/job processes use separate permissions; local fixtures need no production credentials |
| J02 | Juiced: GitHub/Google browser auth, CLI device grants, account/device endpoints | J01 | Verified personal account; safe linking; approval/denial/expiry; cross-process refresh; revoke all device requests/streams within the bound |
| J03 | Juiced: provisioning adapter and reconciliation | J02, C03, C04 | Entitled bootstrap from two devices converges; killed workers resume; pending/failure states actionable; no secrets returned |
| J04 | Juiced: account-bound relay, managed Git stop endpoint, terminal lifecycle | J03 | All existing workflows routed; cross-account IDs denied; no raw DB credentials; streaming, cancellation and retries preserve protocol semantics |
| J05 | Juiced CLI: managed commands/context and scoped local state | J02-J04 | Login/logout/whoami, captured account target, self-managed opt-in, no fallback; account switch/reconnect cannot reuse another account's receipts/refs |
| A01 | All: free-account qualification and deployment | C04, J05 | Two real accounts complete the workflow matrix; default free allowances and per-App resource limits; recovery and rollback demonstrated |
| C05 | Cantelop: durable allocation usage and cursor API | C04 | Duplicate/reordered/outage/crash events reconcile once, including detached/idle/auth allocations |
| C06 | Cantelop: prepaid budget reservations, fenced lease renewal/deadlines | C05, P01 lease proof | Concurrent activation and control outage cannot exceed granted allowance; expiry stops native children; resource and budget denials are actionable |
| J06 | Juiced: subscription checkout/portal, event inbox, entitlements, usage UI | J03, C05, C06 | Sandbox billing lifecycle, out-of-order/duplicate events, period rollover and exhausted state agree with enforced platform allowance |
| R01 | Juiced/Cantelop: release manifest, compatible upgrades, canary/rollback | C03, J05 | Exact CLI/runtime pairs; upgrade waits for active work to drain; interruption/recovery and data-schema compatibility tested |
| R02 | Juiced: existing-data migration and complete deletion/recovery runbooks | C04, J05, J06, R01 | Verified legacy ownership; no secret cloning; recoverable partial migration; purge observed across filesystem/database/App and policy fences |
| R03 | Juiced/SDK: npm packaging, supported OS smoke tests, CI and operator documentation | J05, R01 | Fresh-machine packed install works without source/Docker/Cantelop CLI; package contains no server code or secrets; SDK sync helper is available |
| Q01 | All: paid-production load, isolation, disaster recovery and release gates | C06, J06, R01-R03 | Qualification matrix, enforced hard caps, restores, provider outage behavior, canary and rollback all pass |

The main dependency path is P00/P01 -> C01-C04 + J01/J02 -> J03-J05 -> free accounts,
then C05/C06 + J06 -> release/lifecycle/package qualification -> paid production.
Free accounts retain per-App concurrency and shape quotas. Keep Fleet and host
capacity limits bounded while qualifying the launch. Customer usage-based
hard-cap claims wait for C05/C06.
No calendar estimates are attached until P00/P01 resolve the version baseline,
storage enforcement and lease costs; these are the largest current uncertainties.

## Concrete code touchpoints

| Repository | Existing locations to extend | New modules/directories |
| --- | --- | --- |
| Juiced | `src/args.ts`, `src/cli.ts`, `src/cantelop.ts`, `src/session-state.ts`, `src/git-workspace.ts`, `src/local-publish.ts`, `src/file-sync.ts`, `scripts/build.mjs`, `package.json` and existing CLI integration tests | `src/account/`, `src/managed-connection.ts`, `service/src/{auth,accounts,relay,provisioning,billing,usage,jobs,db}/`, `contracts/`, managed integration harness and release scripts |
| Cantelop | `console/core/http/auth.ts`, `console/core/db/schema.ts`, configuration/deployment/release repositories and workers, `console/workers/control/command.ts`, `console/web/app/v1/`, `docs/openapi-console.yaml`, API contract tooling | Fleet/principal/package/installation/policy/usage services and migrations; operator management commands/pages |
| Fire Fuse in Cantelop | `fire-fuse/runtime/microvm/admission.go`, release admission, SQLite persistence, dispatcher activation/recovery, private provider projections, storage writers/mount quotas | Managed-App resource policies, durable credit leases, execution deadlines, usage outbox and recovery tests |
| SDK | Existing `src/integration.ts`, `src/edge-connection.ts`, `src/compiler.ts`, `src/build.ts`, protocol/stream/sync tests | Changes only where a qualified contract requires them; no second tenant hierarchy or hand-written runtime fingerprint |

P00 is necessary because the adjacent SDK checkout currently reports 1.3.1 while
Juiced pins and has used 1.4.0. Do not downgrade working Juiced environment commands
or derive the managed allowlist from the stale checkout. Align source commits and
published package contents before editing/releasing the SDK. Keep production
runtime graphs stable: isolate managed connection/auth code from Sandbox imports
and prove the compiler strips backend-only dependencies as intended.

## Billing and entitlement behavior

Use hosted subscription Checkout and the customer portal initially. The backend
binds the billing customer to the checked account and selects an allowed price.
An OAuth login or Checkout redirect is not proof of payment. Persist verified
webhook events before processing; fetch current authoritative subscription/invoice
state to handle reordering, and reconcile periodically. This follows Stripe's
[subscription integration](https://docs.stripe.com/billing/subscriptions/build-subscriptions)
and [webhook guidance](https://docs.stripe.com/webhooks).

Grant a period allowance only once for a verified entitlement period, keyed by
subscription/period and ledger identity. Retries, invoice redelivery, proration,
payment method updates and the browser return URL cannot refill credits. Start
with one plan and no mid-period automatic allowance increase; encode explicit
operator grants and corrections as auditable ledger adjustments. Provider-specific
payment IDs stay outside infrastructure policy records.

For V1, inactive/unpaid accounts can sign in, manage payment/devices, inspect
passive account metadata, stop work, request deletion, and use defined export
facilities. They cannot create arbitrary compute. Period-end cancellation
preserves paid access until the entitlement end. Payment failure and suspension
close new runtime admission and bound active work by already-reserved deadlines;
any grace is an explicit policy with an explicit funded allowance. At cap, no
automatic charges or automatic fresh credits. Period rollover creates a new
budget epoch; outstanding old-period reservations are finalized against that
epoch instead of charged twice or made available twice.

Keep infrastructure usage in Cantelop and the Juiced ledger rather than depending
on an eventually delivered payment event to stop workloads. Fixed subscriptions
do not require a customer metered-overage integration. Revisit the external
metering product only if a later pricing model needs it.

## Test and operational qualification

Use real PostgreSQL migrations and the durable Fire Fuse store for concurrency,
recovery and idempotency tests; mock HTTP only where testing provider contracts.
Include the actual compiled CLI, Edge and Sandbox artifacts in cross-repository
tests, with the selected published SDK tarball. A mocked selector test cannot
establish isolation in compute, storage or credential projection.

| Scenario | Required result |
| --- | --- |
| Two accounts, identical project slug | Separate files, settings, GitHub secrets, Claude state and histories |
| Copied Workspace/Session/message IDs, routing headers and cursors | No cross-account read/mutation or resource enumeration; current global Session ID collisions can safely conflict rather than requiring a new ID namespace |
| Git, sync, inspection, sessions, login, local publication, environment changes and delete | All use the same immutable account binding; deny-default local publication is preserved |
| Concurrent device login and provisioning; worker death at every external boundary | One App/installation; durable resumable operation and no lost mapping |
| Refresh races, token theft/replay, device revoke, terminal tickets | Grants rotate/revoke as designed; streams/terminals close within the bound; CLI never receives provider DB/App tokens |
| Laptop/relay/control outage, SSE cursor expiry and reconnect | Existing journal recovery; no automatic resubmission or hidden account switch |
| Parallel VMs, idle warm time, queued retry/recovery and maintenance at cap | Host admission and prepaid deadlines prevent budget bypass |
| Duplicate/gapped/out-of-order usage, host crash and billing rollover | Ledger/reservation conservation; corrections visible and deduplicated |
| Native tool writes, Git import, sync upload, database growth and transfer flood | Byte/inode/database/egress quotas enforced below client code |
| Package source archival, concurrent upgrade, older CLI, downgrade and schema migration | Artifacts retained, exact runtime compatibility, canary/rollback or clear upgrade-required response |
| Account cancellation/deletion and provider outage mid-purge | No new admission; partial steps resume; filesystem/database removal observed; audit/financial retention explicit |
| New machine install with empty config/PATH | CLI package and SDK helpers work without deployment tools/source; managed auth fails clearly and help/version stay offline |

Run existing Juiced `check`, tests, builds and relevant local/live harnesses.
For Cantelop, run affected Console/Edge/Go tests plus architecture, CLI/API and
SDK/platform contracts; include state-compatibility tests for Fire Fuse changes.
Run SDK package/build/protocol/sync qualification if SDK behavior changes. Add
new managed two-account, billing-sandbox and hard-cap harnesses to release CI.
Run live qualification against a dedicated staging Fleet with cleanup and a
bounded test budget, never an operator's personal production Workspace.

Proposed production acceptance targets, to be measured in the chosen region:
relay-added p95 prompt handoff latency <=100 ms at agreed launch concurrency;
device revocation <=30 seconds; no buffering-induced SSE pauses; provisioning
progress persists across deploys; host execution never extends beyond its funded
lease including measured shutdown time. P01/load tests set the launch concurrency,
provisioning target, memory/upload ceilings and shutdown reserve explicitly.
Maintain dashboards for provisioning age/failures, request/stream errors, active
leases, usage ingestion lag, remaining Fleet budget and incomplete purges.

Use structured request/operation/account/App IDs for correlation. Never log
prompt/code content, env values, auth codes, bearer tokens or raw upstream error
bodies. Back up Juiced/PostgreSQL and installation mappings, encrypt credential
material with managed keys, rotate signing/service keys, and test restoration.
After restore, reconcile external Apps, ledger epochs and reservations before
re-enabling admission; a backup rollback must not resurrect revoked devices or
make already-consumed allowance spendable again. Revoke all restored device
grants and require sign-in again. Reconstruct authoritative usage/reservation
high-water marks before issuing credit; fail closed if that evidence is missing.

## Rollout and remaining launch inputs

1. Establish compatible source pins, contracts and local staging fixtures.
2. Deploy additive platform migrations, then compatible compute/storage and
   control workers, then expose the new Fleet API. Managed Apps fail closed on
   missing policy; self-managed legacy Apps retain their existing behavior.
3. Publish/qualify the first immutable Juiced package; provision a staging Fleet
   with two accounts and run the full isolation/recovery harness.
4. Deploy Juiced auth/API/jobs and distribute the CLI candidate. New accounts use
   the default free allowance with per-App resource limits.
5. Add/qualify usage reservations and subscription billing in test mode. Exercise
   cap exhaustion, payment failure, outage, rollover, migration and deletion.
6. Select the public package name, domain, hosting/secrets, license, price and
   allowances, storage/retention terms, and support/incident ownership. Verify
   GitHub/Google apps, payment account and production quota approval.
7. Run paid-production qualification, release to operator accounts, then a bounded
   customer canary, then expand under explicit Fleet limits. Keep an admission
   kill switch; draining/disabling new work must preserve data and safe stop.

Upgrade an App only when compatible active work has drained; pin desired version
per installation and use existing release reconciliation. Refuse incompatible old
CLIs with recovery instructions before workload creation. Binary rollback requires
state compatibility or a tested restore; do not mark a fleet rollback safe merely
because the previous image still exists.

For legacy data, verify administrative ownership and choose explicit App adoption
or backup/restore into a new installation. Never associate a new account with the
legacy `juiced` App automatically. Preserve/rebind canonical state deliberately,
retain a rollback copy until verification, and require explicit confirmation
before deleting the legacy App. Account deletion fences provisioning/upgrade
workers first, revokes devices/tickets, stops/purges Workspaces and databases,
then archives and reconciles the App; track backups and audit/financial retention
separately. Define exact retention durations before accepting paying users.

The feature branches implement the service, CLI, package installation and funded
host enforcement. The remaining work is deployment configuration and qualification
against real providers and a dedicated Linux/KVM host. Follow
[the operations guide](managed-service.md) before enabling admission or charging
customers; local fixtures do not establish those production properties.
