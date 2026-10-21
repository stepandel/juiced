CREATE INDEX usage_events_epoch ON usage_events(account_id,(payload->>'epoch'));
