# CLI telemetry

Juiced can report a small set of product analytics events through the configured
Juiced service to PostHog. Collection is disabled on the service until an operator
sets a PostHog project key. Events are best effort; analytics failures never fail
an installation or command. Events lost while collection is disabled are not
backfilled. A first-run event is retried on a later invocation until acknowledged.

## Control collection

```sh
juiced telemetry status
juiced telemetry disable
juiced telemetry enable
```

The preference is saved locally in `telemetry.json` in Juiced's configuration
directory (`JUICED_CONFIG_HOME` overrides that directory). The command works
offline and does not send an event. An environment opt-out overrides the saved
preference:

```sh
export JUICED_TELEMETRY_DISABLED=1
# DO_NOT_TRACK=1 is also supported.
```

To opt out during installation, set the variable on the shell receiving the pipe:

```sh
curl -fsSL https://juiced.codes/install.sh | JUICED_TELEMETRY_DISABLED=1 sh
```

Set the variable in your shell environment as well to opt out of future CLI runs,
or run `juiced telemetry disable` after installation. CI environments and
`--self-managed` / `JUICED_MODE=self-managed` always disable product telemetry.
The first eligible invocation prints a notice before creating analytics metadata.
Help, version, telemetry settings, and installer version checks do not count as
first use. Logout rotates the anonymous identity while preserving the installation
ID, so switching accounts does not merge two people's analytics profiles.

## Events and identities

| Event | Trigger | Useful measure |
| --- | --- | --- |
| `cli_installed` | Installer has verified the release and replaced the command successfully | Install completions, split by `install_kind=fresh` or `update` |
| `cli_first_run` | First ordinary managed CLI invocation acknowledged by analytics | Install-to-launch conversion |
| `cli_login_succeeded` | Server commits a successful device-code grant | Unique signed-in users; refreshes are excluded |
| `cli_session_connected` | Interactive agent initialization succeeds or the native terminal reports ready | Working session connections and active users |
| `cli_session_active` | A prompt/input is accepted, or an attached interactive agent is still working | Engagement and usage across days |

Session events include `session_mode=interactive` or `terminal`. Session activity
is limited to one event per five minutes per CLI process; idle connections do not
emit activity. Native headless execution emits activity when ready; terminal input
emits activity after acceptance. Session events are client confirmations sent over
an authenticated API. They are not a measure of completed Claude tasks or compute
duration. A connection event is emitted once per CLI launch, including reattachment
to an existing conversation.

Each event carries CLI version, OS, architecture, and a random installation ID.
The installation ID survives upgrades and logout. A separate random anonymous ID
links install/first-run events to an opaque account user ID after a confirmed login
or authenticated session event. Existing signed-in installations are linked when
they next open a session. PostHog receives no email addresses or device labels.
Two computers can therefore count as two installations and one signed-in person.
Deleting local configuration creates a new installation ID. Reinstalling over an
existing Juiced command is classified as an update, even for the same version.

The event contract rejects extra fields. Analytics never includes prompts, source
code, terminal output, paths, workspace or repository names, command arguments,
tokens, raw error messages, or machine fingerprints. GeoIP enrichment is disabled
in PostHog; client IP and User-Agent headers are not forwarded to PostHog. Hosting
and authentication logs remain separate from optional product analytics.

## Enable PostHog

1. Create a PostHog project and find its **project API key** (public ingestion key).
2. Configure these server environment variables in Vercel, then deploy the service:

   ```sh
   JUICED_POSTHOG_KEY=phc_your_project_key
   JUICED_POSTHOG_HOST=https://us.i.posthog.com
   # EU projects: https://eu.i.posthog.com
   ```

3. Release the updated CLI and installer. The PostHog key stays on the server;
   no CLI rebuild is needed to change the key or region.
4. On a test installation with telemetry enabled and CI unset, install and run
   `juiced login`, launch `juiced claude`, and send a prompt. Confirm the events
   in PostHog's activity feed.

Only the US and EU PostHog Cloud ingestion origins are accepted. No key means the
endpoint returns 204 without authentication, database writes, or forwarding.
Enabled ingestion accepts only the documented event schema and a bounded body;
session events require a valid Juiced access token. It rate-limits ingestion per
authenticated user or trusted ingress IP (hashed locally), falling back to the
installation ID when an ingress IP is unavailable. PostHog calls have a short
timeout and cannot change the result of sign-in or runtime commands.

## Dashboard setup

- **Installations:** unique `installation_id` on `cli_installed`, filtered to
  `install_kind=fresh`; show updates as a separate series.
- **Activation funnel:** `cli_installed` (fresh) → `cli_first_run` →
  `cli_login_succeeded` → `cli_session_connected`, using PostHog's person identity.
- **Daily/weekly active users:** unique users performing `cli_session_connected`
  or `cli_session_active`; those events always use authenticated user IDs.
- **Retention:** start with `cli_session_connected`, then count users returning
  with either session event on day 1, day 7, and week 4.
- **Version adoption:** break down session events by `cli_version`, `os`, and `arch`.

Count event totals for connections, and unique users for people. Existing users
who upgrade are an update cohort, not new installs. Opt-outs, offline runs,
blocked requests, deleted configuration, and failed delivery limit completeness;
uninstall counts are unavailable. PostHog access and event retention are configured
by the project operator in PostHog.
