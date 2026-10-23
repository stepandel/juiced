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
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_read ON jobs FOR SELECT USING (true);
CREATE POLICY jobs_insert ON jobs FOR INSERT WITH CHECK (true);
CREATE POLICY jobs_update_release ON jobs FOR UPDATE USING (
  coalesce((SELECT generation::text=coalesce(current_setting('juiced.release_generation',true),'0')
    FROM juiced_release WHERE singleton),true)
);
CREATE POLICY jobs_delete_release ON jobs FOR DELETE USING (
  coalesce((SELECT generation::text=coalesce(current_setting('juiced.release_generation',true),'0')
    FROM juiced_release WHERE singleton),true)
);
ALTER TABLE installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY installations_read ON installations FOR SELECT USING (true);
CREATE POLICY installations_insert ON installations FOR INSERT WITH CHECK (true);
CREATE POLICY installations_update_release ON installations FOR UPDATE USING (
  coalesce((SELECT generation::text=coalesce(current_setting('juiced.release_generation',true),'0')
    FROM juiced_release WHERE singleton),true)
);
CREATE POLICY installations_delete_release ON installations FOR DELETE USING (
  coalesce((SELECT generation::text=coalesce(current_setting('juiced.release_generation',true),'0')
    FROM juiced_release WHERE singleton),true)
);
