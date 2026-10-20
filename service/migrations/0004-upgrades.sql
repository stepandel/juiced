ALTER TABLE installations ADD COLUMN desired_package_id text;
ALTER TABLE installations ADD COLUMN desired_runtime_id text;
CREATE TABLE api_limits(key text PRIMARY KEY,bucket bigint NOT NULL,count integer NOT NULL);
