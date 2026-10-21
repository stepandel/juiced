ALTER TABLE installations ADD COLUMN upgrade_generation integer NOT NULL DEFAULT 0;
ALTER TABLE installations ADD COLUMN operation_id text;
