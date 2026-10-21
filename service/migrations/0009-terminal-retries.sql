ALTER TABLE terminal_leases ADD COLUMN close_after timestamptz NOT NULL DEFAULT now();
CREATE INDEX terminal_leases_closure ON terminal_leases(close_after) WHERE revoked_at IS NULL;
