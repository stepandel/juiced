CREATE TABLE accounts (
  id text PRIMARY KEY, owner_user_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleting','deleted')),
  entitlement text NOT NULL DEFAULT 'inactive' CHECK(entitlement IN ('inactive','active','exhausted')),
  period_id text, period_end timestamptz, included_credits bigint NOT NULL DEFAULT 0 CHECK(included_credits>=0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships(account_id text REFERENCES accounts(id),user_id text NOT NULL,role text NOT NULL CHECK(role IN ('owner','member')),PRIMARY KEY(account_id,user_id));
CREATE TABLE devices(id text PRIMARY KEY,user_id text NOT NULL,label text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX devices_user ON devices(user_id);
CREATE TABLE device_refresh_tokens(refresh_id text PRIMARY KEY,device_id text NOT NULL REFERENCES devices(id));
CREATE TABLE installations(id text PRIMARY KEY,account_id text NOT NULL UNIQUE REFERENCES accounts(id),external_key text NOT NULL UNIQUE,
  platform_id text UNIQUE,app_id text UNIQUE,package_id text NOT NULL,runtime_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','provisioning','ready','failed','deleting','deleted')),error_code text,
  policy_revision integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs(id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,fence integer NOT NULL DEFAULT 0,error_code text,
  idempotency_key text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX jobs_ready ON jobs(status,available_at);
CREATE TABLE subscriptions(account_id text PRIMARY KEY REFERENCES accounts(id),customer_id text NOT NULL UNIQUE,subscription_id text UNIQUE,status text NOT NULL DEFAULT 'incomplete');
CREATE TABLE billing_events(id text PRIMARY KEY,type text NOT NULL,payload jsonb NOT NULL,processed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE entitlement_grants(id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),credits bigint NOT NULL CHECK(credits>=0),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE usage_events(id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),sequence bigint NOT NULL UNIQUE,credits bigint NOT NULL CHECK(credits>=0),payload jsonb NOT NULL);
CREATE TABLE settings(key text PRIMARY KEY,value text NOT NULL);
CREATE TABLE audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,account_id text REFERENCES accounts(id),actor text NOT NULL,action text NOT NULL,target text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
