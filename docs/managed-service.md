# Managed Juiced service

The CLI defaults to Juiced accounts. Juiced owns the Cantelop Fleet, provisioning
and billing; customers sign in with GitHub or Google and bring their Claude login.
Each personal account gets one isolated Cantelop App. Projects are Workspaces,
and conversations remain Sessions. `--self-managed` selects the existing direct
Cantelop workflow explicitly.

## Install and sign in

There is no public service URL yet. Until one is selected and deployed:

```sh
npm install --global juiced
juiced --service https://YOUR-SERVICE login
juiced whoami
juiced claude
juiced logout                  # revoke this CLI device
juiced logout --all            # revoke every CLI device for this user
```

The service choice is remembered after login. `JUICED_SERVICE_URL` overrides it.
A release can bake in an HTTPS origin with `JUICED_DEFAULT_SERVICE_URL` during
`npm run build`. Headless setup uses `login --no-browser`; ordinary commands
never prompt for account login when stdin is not a terminal. Help/version work
offline. Account selection uses a leading `--account acc_...`.

OS credential storage is preferred (macOS Keychain, Windows Credential Manager,
Linux Secret Service). The optional native dependency can be omitted. A private
`0600` file is the fallback; `JUICED_CREDENTIAL_STORE=file` selects it explicitly.
A locked/unavailable store containing an existing credential fails without
silently downgrading. Config directories are under the user's normal application
configuration directory; `JUICED_CONFIG_HOME` overrides the location. Refresh is
serialized across processes and credentials are atomically replaced. Service
origins, accounts, installation IDs and canonical Workspace IDs namespace saved
sessions, Git refs and publication receipts.

`/account` manages subscriptions, usage, devices, explicit provider linking and
account deletion. Providers are never implicitly linked solely by email. Native
Claude authentication remains a separate, per-Workspace action.

## Service processes and configuration

`service/` contains separate API/web and worker entry points, SQL migrations,
provider-backed authentication and durable jobs. `contracts/` is shared with the
packaged CLI. The npm package includes CLI assets; private service code stays out.

1. Publish SDK **1.5.0** from the SDK PR before releasing Juiced. It adds compiled
   transport rebinding and the public relay validators. The current lock declares
   the pending registry tarball without a fabricated integrity hash. After SDK
   publication, run `npm install --package-lock-only --ignore-scripts`, record the
   registry integrity, and rerun `npm ci` and `npm run check:package`. Local/CI
   qualification can install a tarball built from the pinned SDK commit.
2. Set the values in `service/.env.example`. Production requires both OAuth
   providers, PostgreSQL, a Fleet, approved package/runtime IDs and Stripe's
   fixed-price subscription and portal configuration. Remote PostgreSQL uses
   certificate verification. Register OAuth callbacks at
   `https://YOUR-SERVICE/api/auth/callback/github` and `/google`.
3. Run `npm run migrate:service` as the schema owner. Apply
   `service/deploy/roles.sql` after migrations and provision login secrets outside
   source control. The API role cannot update paid periods, included credits,
   usage or immutable grants. Use separate database credentials and Fleet
   principals for API and worker; only the worker may provision or change policy.
4. Start `npm run start:service` and `npm run worker:service`, or build
   `service/deploy/Dockerfile` and run its Compose example behind TLS. Keep the API
   port private. `/health` checks process liveness; `/ready` checks database access.
   Run reviewed grants again when later migrations introduce tables.
5. Configure Stripe's webhook URL `/webhooks/stripe`, subscribing to customer,
   subscription, invoice and Checkout events. Events are signature checked and
   durably stored before acknowledgement. Use test keys until qualification.
   The configured price must be recurring, licensed, positive and fixed per unit.
   The portal must disable subscription price changes. Configure payment methods,
   invoice access and cancellation there; no metered items or automatic overages
   are created by Juiced.
6. Supply only actual reverse-proxy CIDRs in `JUICED_TRUSTED_PROXY_CIDRS`. The Node
   server derives the client IP from its socket, strips the incoming private IP
   header, and interprets forwarding chains only from trusted peers. Limit auth
   traffic at the public ingress as well. The provider also persists rate limits.

Do not enable `JUICED_ADMISSION_ENABLED` until the deployment has passed the
qualification below. Setting it to `false` closes new API work. To stop existing
compute too, suspend accounts or stop lease renewal; prepaid host grants expire.

## Allowances and isolation

The fixed allowance covers infrastructure; Claude model access uses the user's
own Claude authentication. Rate card `allocated-compute-v1` charges integral
credits: **1024 per allocated vCPU-second plus one per MiB-second of maximum guest
memory capacity**, including the configured hotplug capacity. This is capacity,
not measured RSS or model tokens. Shutdown after suspension can conservatively
consume up to five seconds of funded capacity. Choose included quantities and
prices from observed costs before accepting paying customers.

Current policy permits two VMs, eight aggregate vCPUs, 9216 MiB aggregate guest
capacity, and eight Workspaces sharing a 10 GiB ceiling: each Workspace gets a
1 GiB JuiceFS hard quota and a 256 MiB Turso database limit. VM/Workspace admission
is checked atomically. Retained storage continues occupying allocation until
both database and filesystem purge succeed. Host memory includes additional VMM
and filesystem overhead; account limits refer to guest capacity.

Only the service holds App integration tokens. The CLI sends opaque device
credentials to its service. The relay validates SDK commands and sync paths,
blocks raw database credentials and arbitrary private routes, pins account and
installation, and forwards streams with backpressure and cancellation. Environment
mutations and native-auth mutations require an owner. Stream authorization is
rechecked every five seconds; single-use auth terminals are recorded and closed
by a worker after device revocation. Git cleanup uses a typed server operation
that retires observed checkout tokens after stopping the Session.

Paid invoices grant immutable allowance epochs. Duplicate or delayed webhooks
cannot refill an exhausted epoch. The worker fetches canonical Stripe state;
reconciliation also polls to repair missed events. Expired/delinquent accounts
cannot start work. Bounded credit reservations are bound to host boot identities;
only durable final host evidence returns unused credits. Ambiguous or lost-host
reservations remain reserved until reconciled. Usage displayed in the account
page is settled usage; recent and uncertain usage remains pending.

Policy projections include a monotonic job fence, so a worker that lost its
database lock cannot undo a newer suspension. External-key tombstones serialize
deletion with ambiguous or still-running App creation.

Account deletion first revokes devices and records a durable intent. The worker
expires outstanding Checkout sessions (recovering ambiguous creation by its
Stripe idempotency key), cancels subscriptions, closes App admission and waits for
filesystem/database purges. It then removes memberships and authentication
identity. Billing references and anonymous accounting/audit records remain for
operational reconciliation; publish a retention/privacy policy before launch.

## Releases and recovery

Bootstrap requires an exact compiled runtime fingerprint and a minimum CLI
version. Changing the approved package queues a durable upgrade generation.
Managed admission drains existing VMs before package activation; old connections
stay pinned and cannot submit new work during the transition. Publish an older
compatible package as the desired release to roll back. Existing Cantelop release
activation and additive database migration rules still apply; never claim a
rollback reverses destructive application data changes.

For canaries, deploy the new API/worker to a separate alpha Fleet/service origin
first. Pin its package/runtime pair, qualify two accounts, then promote the same
immutable package in the production Fleet and CLI build. Keep Fleet and host
capacity limits deliberately small until load/lease-renewal latency is measured.
Current placement targets one configured compute ingress; multi-host scheduling
is a later extension, and a boot identity change prevents pending grants from
being reused on a replacement host.

Operator commands use the worker database credential:

```sh
node --import tsx service/scripts/admin.ts status
node --import tsx service/scripts/admin.ts grant-alpha acc_... CREDITS ISO_EXPIRY
node --import tsx service/scripts/admin.ts suspend-all
node --import tsx service/scripts/admin.ts invalidate-devices
```

Alpha grants are explicitly operator funded, integral and expire within seven
days. Watch pending/stale jobs, billing retries, unreconciled reservations,
policy/enforced revision lag, principal expiry, purge failures, pool wait times
and lease-renewal latency. Worker diagnostics use fixed error codes and contain
no credentials, command bodies or terminal content.

After a database restore, keep admission and worker renewal disabled. Stop old
hosts or verify their watchdogs killed all funded VMs, invalidate browser/CLI
sessions, restore the accounting ledger from authoritative WAL/backups, reconcile
host evidence and Stripe, and conservatively charge ambiguous reservations.
Never reset usage cursors, mint replacement epochs or release reservations merely
to make counters look healthy. Resume with bounded operator canaries. Rotate
principals and webhook secrets through their providers; Better Auth supports
versioned encryption secrets through `BETTER_AUTH_SECRETS`. Retain prior keys
until encrypted provider credentials have migrated; device tokens can be revoked
independently.

## Qualification before paid launch

Automated suites cover provider device grants and refresh/revocation, account
boundaries, concurrent App creation, finite reservations, settlement replay,
canonical billing replay/renewal, crash recovery, stream forwarding/cancellation,
private package contents and clean installation. They use disposable PostgreSQL
and local transport fixtures.

A production URL, GitHub/Google app registrations, Stripe product/portal/webhook
configuration and live infrastructure have not been supplied or deployed by this
change. Before paid launch, run the full two-account workflow with real OAuth,
Stripe test payments, independent secrets, Claude state, identical project names,
Git transfers, file sync, and interrupted/reconnected sessions. On a Linux/KVM
managed host, prove native writes hit filesystem/database limits; freeze the
runtime daemon while a long-running native child is active and verify watchdog
cgroup termination; freeze the watchdog and verify runtime admission closes.
Exercise provider outages, restart/recovery, rolling upgrades, rollback, deletion
with retained data, PostgreSQL restore and peak lease-renewal load. Keep admission
closed if any gate lacks evidence.
