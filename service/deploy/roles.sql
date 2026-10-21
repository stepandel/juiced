-- Run once as the database owner AFTER migrations. Set LOGIN credentials through
-- your database's secret manager; these roles deliberately have no passwords here.
CREATE ROLE juiced_api LOGIN;
CREATE ROLE juiced_worker LOGIN;
GRANT USAGE ON SCHEMA public TO juiced_api,juiced_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO juiced_api,juiced_worker;
GRANT INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO juiced_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO juiced_api,juiced_worker;
GRANT INSERT,UPDATE,DELETE ON "user","session","account","verification","oauthClient","oauthResource","oauthClientResource","oauthRefreshToken","oauthAccessToken","oauthConsent","oauthClientAssertion","deviceCode","rateLimit",devices,device_refresh_tokens,terminal_leases,api_limits TO juiced_api;
GRANT INSERT(id,owner_user_id) ON accounts TO juiced_api;
GRANT UPDATE(status,entitlement) ON accounts TO juiced_api;
GRANT INSERT ON memberships,installations,jobs,billing_events,subscriptions,checkout_sessions,audit TO juiced_api;
GRANT UPDATE(desired_package_id,desired_runtime_id,upgrade_generation,operation_id) ON installations TO juiced_api;
GRANT UPDATE ON checkout_sessions TO juiced_api;
-- Rerun reviewed GRANT changes with future schema migrations. The API has no
-- UPDATE privilege on paid periods, included credits, usage, or immutable grants.
