ALTER TABLE installations ADD COLUMN entitlement_epoch text;
ALTER TABLE accounts ADD COLUMN period_start timestamptz;
ALTER TABLE subscriptions ADD COLUMN reconciled_at timestamptz;
ALTER TABLE billing_events ADD COLUMN error_code text;
CREATE TABLE checkout_sessions(account_id text PRIMARY KEY REFERENCES accounts(id),intent_id text NOT NULL,url text,expires_at timestamptz NOT NULL);
CREATE TABLE terminal_leases(id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),device_id text NOT NULL REFERENCES devices(id),installation_id text NOT NULL REFERENCES installations(id),workspace_id text NOT NULL,session_id text NOT NULL,revoked_at timestamptz,expires_at timestamptz NOT NULL);
CREATE INDEX terminal_leases_live ON terminal_leases(device_id,expires_at) WHERE revoked_at IS NULL;
