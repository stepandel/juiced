# Managed Juiced service

The CLI defaults to Juiced accounts. Juiced owns the Cantelop Fleet, provisioning
and billing; customers sign in with GitHub or Google and bring their Claude login.
Each personal account gets one isolated Fleet instance. Projects are Workspaces,
and conversations remain Sessions. All clients use the authenticated service.

## Install and sign in

The account-service origin is `https://juiced.codes`. Public CLI releases use the
[shell installer](cli-releases.md), with bundled Node and dependencies; npm
publication is not required. The installer needs the first public GitHub Release
and a website deployment before its public URL is usable. The unscoped npm name
`juiced` is reserved by npm, so do not install its unrelated registry placeholder.
Build and link this repository while the public service is being configured:

```sh
npm install
npm run build
npm link
juiced login
juiced whoami
juiced claude
juiced logout                  # sign out on this computer, across terminal windows
juiced logout --all            # sign out every CLI session for this user
```

Juiced sign-in is shared by terminal windows for the same user on a computer.
Running `juiced login` again reuses a valid sign-in, including when multiple
terminals run it at once. To switch accounts, run `juiced logout` first.
The account console lists CLI sign-ins and can revoke one or all of them.
Its **Sign out of browser** button ends the browser session; CLI sessions stay signed in.

The service choice is remembered after login. `JUICED_SERVICE_URL` overrides it.
Builds default to `https://juiced.codes`; `JUICED_DEFAULT_SERVICE_URL` overrides
that build-time default. Headless setup uses `login --no-browser`; ordinary commands
never prompt for account login when stdin is not a terminal. Help/version work
offline. Account selection uses a leading `--account acc_...`.

Sign-in tokens are stored in a private `0600` file inside a `0700` configuration
directory on macOS/Linux. This is the only credential storage method; no OS
keychain or storage setting is required. Other programs running as the same user
can read the tokens. Config directories are under the user's normal application
configuration directory; `JUICED_CONFIG_HOME` overrides the location. Refresh is
serialized across processes and credentials are atomically replaced. Service
origins, accounts, installation IDs and canonical Workspace IDs namespace saved
sessions, Git refs and publication receipts.

Credentials live in the `credentials/` subdirectory of the configuration
directory. Releases up to 0.2.3 used a file of the same name one level up and
rewrite it with OS-keyring metadata on every token refresh, so newer releases
never write that path; an older CLI process left running during an upgrade
therefore cannot sign newer ones out.

Upgrading from a release that used OS credential storage requires one browser
sign-in with `juiced login` (interactive commands also start login automatically).
Juiced never opens the old OS store, so the upgrade cannot trigger a keychain
password dialog. Old OS entries remain untouched; old device grants can be
revoked from `/account`. Existing private-file sign-ins are moved, not copied,
into `credentials/` on first use: refresh tokens rotate, so a shared copy would
sign one of the two CLIs out. An older CLI still running afterwards asks for its
own sign-in. `juiced logout` removes both files.

`/account` manages subscriptions, usage, devices, explicit provider linking and
account deletion. Providers are never implicitly linked solely by email. Native
Claude authentication remains a separate, per-Workspace action.

## Service configuration

`service/` is the Next.js app. It serves the website and account API and contains
one private Vercel Queue consumer plus one cron endpoint. There is no standalone
server or continuously running worker. `contracts/` stays shared with the CLI;
the npm package includes CLI assets and excludes private service code.

### Vercel deployment

The project is `stepandels-projects/juiced`, connected to `stepandel/juiced` with
production branch `main`, root directory `service`, framework Next.js and Node 24.
Source files outside the root directory must be enabled for shared contracts and
the workspace lockfile. `service/vercel.json` declares the private `juiced-jobs`
queue trigger and the once-per-minute `/api/cron` schedule. Production builds generate the typed Fleet backend, then run
`npm run migrate && next build`, migrating with the Neon integration's owner
`DATABASE_URL`. Preview builds also generate the backend, skip migrations when `VERCEL_ENV=preview`, and run
`next build` without account credentials or database access. Preview account routes
return HTTP 503 until separate preview service configuration is supplied. Vercel
builds do not publish the CLI or compile a Cantelop runtime.

The website is `https://juiced.codes`.
`https://juiced-eight.vercel.app` redirects to the canonical domain.
The homepage is a static Next.js page and
`/health` checks the HTTP handler without account credentials. Account routes and
`/ready` return HTTP 503 until production configuration is supplied. The homepage
links to public docs and pricing. Free includes 10 vCPU hours; Unlimited
($25/month) is marked coming soon. Both plans include all features. In the service
every account starts on the `free` epoch with an effectively unlimited allowance
(10^15 credits until 2100). A paid Stripe
invoice replaces that epoch when billing is configured later. See
[search and AI discovery](search-discovery.md) for verification, sitemap submission,
and baseline measurement after deployment.
`service/public/install.sh` is served at `/install.sh` by Vercel's CDN.

Set the values in `service/.env.example` in the Vercel project. The API uses the
limited `JUICED_DATABASE_URL` role and the `api` integration profile; the private job
consumer uses `JUICED_WORKER_DATABASE_URL` and the `worker` integration profile in
`CANTELOP_APP_CONFIG`. Keep
`JUICED_SERVICE_URL=https://juiced.codes` and `JUICED_ADMISSION_ENABLED=false` until
qualification. A random `CRON_SECRET` protects the cron endpoint; Vercel sends it
as an Authorization bearer token. Queue authentication uses Vercel OIDC and its
consumer is not accessible through a public HTTP URL.

Account bootstrap, deletion, device revocation and verified Stripe webhooks
publish a queue wake-up after their database writes commit. Native-auth terminals
also schedule a wake-up for their expiry. Queue messages carry no credentials or
account payloads: Postgres retains authoritative jobs, billing events, retry
schedules and fencing. Each invocation runs a bounded batch and schedules
short pending retries through delayed queue delivery. Duplicate delivery uses the
existing SQL locks and idempotency keys. If publishing fails after a commit, the
request reports failure and a caller retry or the minute cron recovers the durable
record. Cron also recovers jobs after message expiry and deployment changes.

Canonical Stripe reconciliation runs with these batches, including the minute cron.
The current platform has retired Fleet budget/usage APIs. Juiced does not call them
or display a live compute credit counter. Historical usage rows remain available
through the compatibility usage response with `metering: "retired"`; subscription
status, expiry and projected resource policies control access. API authorization
still checks entitlement and device expiry on each request, and streams recheck
revocation every five seconds. The relay preserves streaming and cancellation;
its 300-second Vercel invocation limit uses the CLI's existing replay reconnect.
Qualify these hosted flows before enabling admission.

For local development or a production build:

```sh
npm ci
npm run dev:service
npm run build:service
npm run start:service
```

For manual deployments from the repository root:

```sh
vercel link --yes --project juiced --scope stepandels-projects
vercel deploy --scope stepandels-projects
vercel deploy --prod --scope stepandels-projects
```

`service/public/` is served by Vercel's CDN. `.vercelignore` excludes local
environment files, tests, build outputs and diagnostics. The local `.vercel/` link
and `.env.local` credentials are ignored by Git. External DNS for `juiced.codes`
must point to the records returned by `vercel domains inspect juiced.codes`.

References: [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs),
[Vercel Queues](https://vercel.com/docs/queues/quickstart),
[cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs), and
[trusted request headers](https://vercel.com/docs/headers/request-headers).

### Account infrastructure

`service/migrations/0001-initial.sql` creates the complete service and
authentication schema, including free-account defaults. Apply it to an empty
database for the first deployment. Migration runs are transactional and serialized;
subsequent runs skip applied migrations and seed the CLI client idempotently.
After launch, schema changes belong in new forward migrations.

1. Install the pinned registry dependency with `npm ci`. SDK **1.5.1** supplies
   shared Fleet packages, compiled transport rebinding and the public relay validators; its registry
   integrity is recorded in the lockfile. `npm run check:package` verifies a fresh
   CLI tarball installation against that dependency. Public CLI distribution uses
   [GitHub Release archives](cli-releases.md), independently of npm publication.
2. Set the values in `service/.env.example`. Production requires both OAuth
   providers, PostgreSQL, a Fleet and approved package/runtime IDs. Stripe is
   optional: without `STRIPE_SECRET_KEY`, billing routes and the webhook return
   `billing_unavailable` and accounts use the default free allowance.
   With it, Stripe's fixed-price subscription and portal configuration is required. Remote PostgreSQL uses
   certificate verification. Register OAuth callbacks at
   `https://juiced.codes/api/auth/callback/github` and `/google`.
3. `service/deploy/production-env.sh` performs this step and writes the
   generated role URLs, auth secret, OAuth and Fleet values to Vercel production
   without echoing them; run it per section (`auth`, `database`, `oauth`,
   `cantelop`). Manually: run `npm run migrate:service` as the schema owner. Apply
   `service/deploy/roles.sql` after migrations and provision login secrets outside
   source control. The API role cannot update paid periods, included credits,
   usage or immutable grants. Use separate database credentials and Fleet
   principals for API handlers and queue jobs; only jobs may provision or change policy.
4. Deploy the Next.js app, queue consumer and cron together through Vercel.
   `/health` checks HTTP liveness; `/ready` checks initialized services and database
   access. Check that unauthenticated `/api/cron` requests are denied and the queue
   route has no public ingress. Run reviewed grants again for later migrations.
5. Configure Stripe's webhook URL `/webhooks/stripe`, subscribing to customer,
   subscription, invoice and Checkout events. Events are signature checked and
   durably stored before acknowledgement. Use test keys until qualification.
   The configured price must be recurring, licensed, positive and fixed per unit.
   The portal must disable subscription price changes. Configure payment methods,
   invoice access and cancellation there; no metered items or automatic overages
   are created by Juiced.
6. Vercel overwrites `x-vercel-forwarded-for`; the handler validates that address
   and strips visitor-supplied private IP headers. Limit authentication traffic at
   public ingress as well. The provider also persists rate limits.

Do not enable `JUICED_ADMISSION_ENABLED` until the deployment has passed the
qualification below. Setting it to `false` closes new API work. To stop existing
compute too, project inactive resource policies and wait for enforced revisions.

## Allowances and isolation

Claude model access uses the user's own Claude authentication. The current Fleet
platform exposes resource limits and subscription expiry rather than prepaid
compute-credit budgets. Choose subscription pricing from observed infrastructure
costs; this service does not advertise a live compute-consumption meter.

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
by a queue job after device revocation. Git cleanup uses a typed server operation
that retires observed checkout tokens after stopping the Session.

Paid invoices grant immutable subscription epochs. Duplicate or delayed webhooks
cannot refill an exhausted epoch. Queue jobs fetch canonical Stripe state and
repair missed events. Expired/delinquent accounts cannot start work. Subscription
records and historical usage remain in PostgreSQL, but this service no longer
claims a platform-enforced compute-credit budget or ingests the retired Fleet
usage feed. Resource caps and expiry are still projected to compute.

Policy projections include a monotonic job fence, so a worker that lost its
database lock cannot undo a newer suspension. External-key tombstones serialize
deletion with ambiguous or still-running App creation.

Account deletion first revokes devices and records a durable intent. A queue job
expires outstanding Checkout sessions (recovering ambiguous creation by its
Stripe idempotency key), cancels subscriptions, closes App admission and waits for
filesystem/database purges. It then removes memberships and authentication
identity. Billing references and anonymous accounting/audit records remain for
operational reconciliation; publish a retention/privacy policy before launch.

## Releases and recovery

Juiced requires shared Fleet execution protocol 1. `npm run build:runtime` checks
the generated Edge manifest, and the compiled-package test verifies that concurrent
installations use their own runtime capabilities and credentials. CI and CLI release
builds run these checks. Updating the SDK dependency alone does not move existing
installations onto shared execution.

To adopt shared execution, first roll out Cantelop migration
`0032_shared_fleet_packages`, the dispatcher with Worker Loader and FleetPackage
bindings, compute, and the control worker. Deploy a source release built with SDK
1.5.1 or newer, then publish a **new** immutable Fleet package from that successful
release. Its Edge manifest must declare `fleet_execution_protocol_version: 1` and
the optional `CANTELOP_FLEET_EXECUTION_VERSION` binding. Poll the package endpoint
until `execution` is `ready`; do not promote `preparing` or `legacy` packages.
Shared installations attach the source release's prepared runtime image and reuse
the package's Edge code while retaining separate credentials, storage and resource policies.

Publish matching CLI archives and deploy with the Fleet-aware Cantelop CLI:

```sh
cantelop deploy --app juiced --fleet flt_... --package-version 1.2.3 --fleet-profile service --create-app
```

The CLI owns package publication and existing-instance rollout. Its private
integration document supplies package/runtime metadata to `CANTELOP_APP_CONFIG`;
use separate API and worker profiles/principals as described in
[Fleet SDK migration](fleet-sdk-migration.md). Remove `JUICED_PACKAGE_ID`,
`JUICED_RUNTIME_ID` and the old individual Fleet token variables from service hosts.
The worker observes the CLI rollout and updates local identity records; it never
calls the package release API itself. Verify a canary instance before broader use.
Package versions remain immutable and retained versions can be rolled back by CLI.

Bootstrap requires an exact compiled runtime fingerprint and a minimum CLI
version. Published CLIs automatically install the service's `JUICED_CLI_VERSION`
(defaulting to its source CLI version) before managed commands. Publish the
matching CLI archives before promoting that version with its package/runtime;
raise `JUICED_MINIMUM_CLI` when older versions must stop starting work. See
[CLI update and recovery behavior](cli-releases.md#updates-rollback-and-removal).
Changing deployment metadata queues a durable observation job. It waits for the CLI-owned rollout rather than upgrading the instance.
Managed admission drains existing VMs before package activation; old connections
stay pinned and cannot submit new work during the transition. Publish an older
compatible package as the desired release to roll back. Existing Cantelop release
activation and additive database migration rules still apply; never claim a
rollback reverses destructive application data changes.

For canaries, deploy the new Next.js app and jobs to a separate staging Fleet/service origin
first. Pin its package/runtime pair, qualify two accounts, then promote the same
immutable package in the production Fleet and CLI build. Keep Fleet and host
capacity limits deliberately small until provisioning and policy-enforcement latency is measured.
Current placement targets one configured compute ingress; multi-host scheduling
is a later extension, and placement/host recovery remains platform-owned.

Operator commands use the worker database credential:

```sh
node --import tsx service/scripts/admin.ts status
node --import tsx service/scripts/admin.ts suspend-all
node --import tsx service/scripts/admin.ts invalidate-devices
```

Accounts start with the free subscription epoch automatically. Watch pending/stale
jobs, billing retries, policy/enforced revision lag, principal expiry, purge
failures and pool wait times. Job diagnostics must not contain credentials, command bodies or terminal content.

After a database restore, keep admission closed and queue/cron processing disabled.
Stop or reconcile old compute, invalidate browser/CLI sessions, restore the
service records from authoritative backups and reconcile subscription and
instance identities before reopening admission. Resume with bounded operator
canaries. Rotate
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

The Next.js website and job infrastructure deploy on Vercel. Production
PostgreSQL, GitHub/Google app registrations, Stripe product/portal/webhook
configuration and Cantelop Fleet/package credentials still require setup. Before paid launch, run the full two-account workflow with real OAuth,
Stripe test payments, independent secrets, Claude state, identical project names,
Git transfers, file sync, and interrupted/reconnected sessions. On a Linux/KVM
managed host, prove native writes hit filesystem/database limits; freeze the
runtime daemon while a long-running native child is active and verify watchdog
cgroup termination; freeze the watchdog and verify runtime admission closes.
Exercise provider outages, restart/recovery, rolling upgrades, rollback, deletion
with retained data, PostgreSQL restore and peak lease-renewal load. Keep admission
closed if any gate lacks evidence.
