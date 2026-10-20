ALTER TABLE billing_events ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE billing_events ADD COLUMN attempts integer NOT NULL DEFAULT 0;
