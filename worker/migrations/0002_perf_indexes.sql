-- Replace the (site_id, status) index with a covering (site_id, status, id)
-- index so the campaign batch cursor query (site_id IN (...) AND status='active'
-- AND id > ? ORDER BY id) doesn't need an extra sort step. The new index's
-- leading columns still cover plain (site_id, status) lookups.
DROP INDEX idx_subscriptions_site_status;

CREATE INDEX idx_subscriptions_site_status_id
ON subscriptions(site_id, status, id);
