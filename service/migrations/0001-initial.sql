-- Initial account-service schema.
-- Free allowances are immutable per Cantelop (App, epoch); 10^15 credits
-- through 2100 is effectively unlimited under allocated-compute-v1.
CREATE TABLE accounts (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleting','deleted')),
  entitlement text NOT NULL DEFAULT 'active' CHECK(entitlement IN ('inactive','active','exhausted')),
  period_id text DEFAULT 'free',
  period_start timestamptz,
  period_end timestamptz DEFAULT '2100-01-01T00:00:00Z',
  included_credits bigint NOT NULL DEFAULT 1000000000000000 CHECK(included_credits>=0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  account_id text REFERENCES accounts(id),
  user_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','member')),
  PRIMARY KEY(account_id,user_id)
);

CREATE TABLE devices (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  label text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE device_refresh_tokens (
  refresh_id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id)
);

CREATE TABLE installations (
  id text PRIMARY KEY,
  account_id text NOT NULL UNIQUE REFERENCES accounts(id),
  external_key text NOT NULL UNIQUE,
  platform_id text UNIQUE,
  app_id text UNIQUE,
  package_id text NOT NULL,
  runtime_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','provisioning','ready','failed','deleting','deleted')),
  error_code text,
  policy_revision integer NOT NULL DEFAULT 1,
  entitlement_epoch text,
  desired_package_id text,
  desired_runtime_id text,
  upgrade_generation integer NOT NULL DEFAULT 0,
  operation_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE projection_fence;
CREATE TABLE jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  fence integer NOT NULL DEFAULT 0,
  projection_fence bigint NOT NULL DEFAULT 0,
  error_code text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs(status,available_at);

CREATE TABLE subscriptions (
  account_id text PRIMARY KEY REFERENCES accounts(id),
  customer_id text NOT NULL UNIQUE,
  subscription_id text UNIQUE,
  status text NOT NULL DEFAULT 'incomplete',
  reconciled_at timestamptz
);

CREATE TABLE checkout_sessions (
  account_id text PRIMARY KEY REFERENCES accounts(id),
  intent_id text NOT NULL,
  url text,
  expires_at timestamptz NOT NULL,
  stripe_id text
);

CREATE TABLE billing_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entitlement_grants (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  credits bigint NOT NULL CHECK(credits>=0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  sequence bigint NOT NULL UNIQUE,
  credits bigint NOT NULL CHECK(credits>=0),
  payload jsonb NOT NULL
);
CREATE INDEX usage_events_epoch ON usage_events(account_id,(payload->>'epoch'));

CREATE TABLE terminal_leases (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  device_id text NOT NULL REFERENCES devices(id),
  installation_id text NOT NULL REFERENCES installations(id),
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  close_after timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terminal_leases_live ON terminal_leases(device_id,expires_at) WHERE revoked_at IS NULL;
CREATE INDEX terminal_leases_closure ON terminal_leases(close_after) WHERE revoked_at IS NULL;

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE api_limits (
  key text PRIMARY KEY,
  bucket bigint NOT NULL,
  count integer NOT NULL
);

CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text REFERENCES accounts(id),
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Authentication tables match the pinned Better Auth and OAuth Provider schema.
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references "user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);

create table "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

create table "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

create table "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table "oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);

create table "deviceCode" ("id" text not null primary key, "deviceCode" text not null, "userCode" text not null, "userId" text, "expiresAt" timestamptz not null, "status" text not null, "lastPolledAt" timestamptz, "pollingInterval" integer, "clientId" text, "scope" text, "resources" jsonb, "oauthClientId" text);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create index "oauthClient_userId_idx" on "oauthClient" ("userId");

create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");

create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");

create index "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");

create index "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");

create index "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");

create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");

create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");

create index "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");

create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");

create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");

create index "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");

create index "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");

create index "oauthConsent_userId_idx" on "oauthConsent" ("userId");

create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");

create unique index "deviceCode_deviceCode_uidx" on "deviceCode" ("deviceCode");

create unique index "deviceCode_userCode_uidx" on "deviceCode" ("userCode");
