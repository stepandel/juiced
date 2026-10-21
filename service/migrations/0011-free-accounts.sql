-- Every account starts with the free allowance. Defaults apply to the API's
-- INSERT(id,owner_user_id), so it gains no privilege. The epoch is constant
-- because Cantelop budgets are immutable per (App, epoch); 10^15 credits is
-- effectively unlimited under rate card allocated-compute-v1.
ALTER TABLE accounts
  ALTER COLUMN entitlement SET DEFAULT 'active',
  ALTER COLUMN period_id SET DEFAULT 'free',
  ALTER COLUMN period_end SET DEFAULT '2100-01-01T00:00:00Z',
  ALTER COLUMN included_credits SET DEFAULT 1000000000000000;
UPDATE accounts SET entitlement='active',period_id='free',period_start=NULL,
  period_end='2100-01-01T00:00:00Z',included_credits=1000000000000000
  WHERE status='active' AND entitlement='inactive' AND period_id IS NULL;
