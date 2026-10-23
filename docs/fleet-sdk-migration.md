# Fleet SDK migration

This migration depends on SDK [PR #65](https://github.com/stepandel/cantelop-sdk/pull/65)
and platform [PR #391](https://github.com/stepandel/cantelop-internal/pull/391).
Juiced pins the published `@cantelop/sdk@1.6.0` registry package in both
manifests and the lockfile. Install with `npm ci --ignore-scripts`; the published
package includes its qualified runtime and native adapter artifacts.

## Definition and clients

`src/cantelop.ts` exports the typed `fleet = cantelop.fleet(...)` definition.
CLI commands bind the compiled contract directly to the authenticated Juiced relay.
End users never receive Fleet principals. There is one account-backed execution
path. Development probes in `src/app.ts` authenticate through that same service.

The service uses a generated backend under `service/.cantelop/client`.
`npm run build:service:client` generates it without importing runtime-only code.
Service build/dev/check/test lifecycle hooks and the Vercel custom build command
generate this client before use. Generated code is ignored by Git and is never
included in the public CLI package.

## Deploy and configure

Deploy the shared package and existing instances through the Fleet-aware CLI:

```sh
# Supply the scoped deployment principal through your secret manager.
cantelop deploy --app juiced --fleet flt_... --package-version 1.2.3 --fleet-profile service --create-app
```

The platform currently publishes packages from a deployed source App, which uses
an App slot in addition to the Fleet's slot. `--create-app` explicitly permits
creating that source App. Use `--resume-package` to resume an interrupted rollout
without publishing another immutable version. Package selection/rollout stays
in the CLI; service provisioning never calls the release endpoint.

Export the CLI's deployment metadata into one private `CANTELOP_APP_CONFIG` JSON
document with `api` and `worker` profiles. Both profiles must select `juiced` with
the same Fleet, package and runtime IDs, but use different service principals:

- API: `installations:read`, `credentials:read`.
- Worker: `installations:read`, `installations:write`, `credentials:read`, `policy:write`.

```json
{
  "schemaVersion": 1,
  "activeProfile": "api",
  "profiles": {
    "api": { "apps": [], "fleets": [{
      "name": "juiced", "id": "flt_<32 hex digits>",
      "controlUrl": "https://cantelop.com", "accessToken": "<API principal>",
      "packageId": "pkg_<32 hex digits>", "runtimeId": "<compiled runtime identity>"
    }] },
    "worker": { "apps": [], "fleets": [{
      "name": "juiced", "id": "flt_<same Fleet ID>",
      "controlUrl": "https://cantelop.com", "accessToken": "<worker principal>",
      "packageId": "pkg_<same package ID>", "runtimeId": "<same runtime identity>"
    }] }
  }
}
```

These placeholders illustrate the shape; use actual CLI metadata and principal
secrets. `CANTELOP_API_PROFILE` and `CANTELOP_WORKER_PROFILE` override the default
profile names. The service checks package metadata and the compiled runtime at
startup. Restart/redeploy processes after changing the integration document;
SDK references capture configuration when their module is loaded.

`service/deploy/production-env.sh cantelop` reads this private JSON from a local
file, checks matching metadata/separate principals and stores it in Vercel
without echoing secrets. The old `CANTELOP_API_URL`, `CANTELOP_FLEET_ID`,
`CANTELOP_FLEET_TOKEN`, `CANTELOP_WORKER_FLEET_TOKEN`, `JUICED_PACKAGE_ID` and
`JUICED_RUNTIME_ID` settings are superseded. Continue setting
`JUICED_CLI_VERSION` and `JUICED_MINIMUM_CLI` for CLI compatibility.

Coordinate the CLI/package rollout, public CLI release, generated service
backend and hosted integration metadata. Older CLI/service runtimes can receive
compatibility errors during the transition. Existing bootstrap jobs now observe
platform status and adopt the matching package/runtime after CLI rollout;
legacy pending `upgrade` jobs are reconciled through that same observation path.
They cannot downgrade or upgrade a remote instance. Existing database columns
and job kinds remain for compatibility; no schema migration is needed.

## Provisioning, authorization and billing

The thin Platform adapter delegates to SDK instance creation, status, policy,
deletion, typed App access and connections. It no longer implements Fleet HTTP
requests, handles raw App tokens, constructs a fake runtime for Git cleanup, or
overrides runtime identity. External-key lookup recovers ambiguous creation;
external-key deletion keeps the platform tombstone semantics. Policy updates
retain source fences, expected revisions and enforcement checks.

Juiced still owns membership/owner authorization, subscription eligibility,
revocation checks, durable job locks, queue retry wake-ups, protocol allowlists,
terminal leases, and stream cancellation. Credentials stay server-side. Relay
connections validate the persisted App/runtime pin and the compiled SDK contract.

The current platform retired `/budget`, `/usage` and `usage:read`. The worker no
longer calls those endpoints or schedules usage ingestion. Stripe reconciliation,
period expiry and resource-policy projection remain active. Historical credit
and usage tables are retained; the compatibility usage endpoint explicitly
reports `metering: "retired"` rather than claiming current metering. The account
page describes subscription/resource-policy access rather than a live credit
counter. This migration does not implement replacement consumption billing or
claim a platform-enforced credit budget.
