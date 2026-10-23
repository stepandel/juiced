-- One active release owns provisioning. Old queue deliveries may outlive a deployment.
CREATE TABLE juiced_release (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL CHECK (generation > 0),
  package_id text NOT NULL,
  runtime_id text NOT NULL,
  promoted_at timestamptz NOT NULL DEFAULT now()
);

-- Production uses existing restricted roles; local databases need neither role.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='juiced_api') THEN
    GRANT SELECT ON juiced_release TO juiced_api;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='juiced_worker') THEN
    GRANT SELECT,INSERT,UPDATE ON juiced_release TO juiced_worker;
  END IF;
END $$;

-- Enforce the boundary for pre-fence deployments too. Their existing SQL cannot
-- claim jobs or overwrite installation identity once a generation is active.
-- The owner still bypasses RLS for migrations/maintenance; runtime roles do not.
-- application_name carries the deployment generation. A newer deployment may
-- write while its rollout runs; promotion fences every older generation.
-- CASE guarantees the cast only sees a well-formed name.
CREATE FUNCTION juiced_release_current() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT CASE WHEN coalesce(current_setting('application_name',true),'') ~ '^juiced-release:[0-9]{1,18}$'
      THEN substr(current_setting('application_name',true),16)::bigint>=generation ELSE false END
    FROM juiced_release WHERE singleton),true)
$$;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_read ON jobs FOR SELECT USING (true);
CREATE POLICY jobs_insert ON jobs FOR INSERT WITH CHECK (true);
CREATE POLICY jobs_update_release ON jobs FOR UPDATE USING (juiced_release_current());
CREATE POLICY jobs_delete_release ON jobs FOR DELETE USING (juiced_release_current());
ALTER TABLE installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY installations_read ON installations FOR SELECT USING (true);
CREATE POLICY installations_insert ON installations FOR INSERT WITH CHECK (true);
CREATE POLICY installations_update_release ON installations FOR UPDATE USING (juiced_release_current());
CREATE POLICY installations_delete_release ON installations FOR DELETE USING (juiced_release_current());
