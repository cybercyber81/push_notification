import type { Env, SubscriptionRow } from "../types";
import { sha256Hex } from "../services/crypto";

export interface UpsertResult {
  ok: boolean;
}

export async function upsertSubscription(
  env: Env,
  siteId: number,
  data: {
    endpoint: string;
    p256dh: string;
    auth: string;
    locale?: string | null;
    userAgent?: string | null;
  }
): Promise<UpsertResult> {
  const endpointHash = await sha256Hex(data.endpoint);
  try {
    await env.DB.prepare(
      `INSERT INTO subscriptions (
         site_id, endpoint, endpoint_hash, p256dh, auth, status,
         user_agent, locale, created_at, updated_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(site_id, endpoint_hash) DO UPDATE SET
         endpoint = excluded.endpoint,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         status = 'active',
         locale = COALESCE(excluded.locale, subscriptions.locale),
         updated_at = CURRENT_TIMESTAMP,
         last_seen_at = CURRENT_TIMESTAMP`
    )
      .bind(
        siteId,
        data.endpoint,
        endpointHash,
        data.p256dh,
        data.auth,
        data.userAgent ?? null,
        data.locale ?? null
      )
      .run();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function unsubscribeByEndpoint(
  env: Env,
  siteId: number,
  endpoint: string
): Promise<boolean> {
  const endpointHash = await sha256Hex(endpoint);
  const res = await env.DB.prepare(
    `UPDATE subscriptions
     SET status = 'unsubscribed', updated_at = CURRENT_TIMESTAMP
     WHERE site_id = ? AND endpoint_hash = ?`
  )
    .bind(siteId, endpointHash)
    .run();
  return res.meta.changes > 0;
}

export async function markExpired(
  env: Env,
  subscriptionId: number
): Promise<void> {
  await env.DB.prepare(
    `UPDATE subscriptions
     SET status = 'expired', last_failure_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(subscriptionId)
    .run();
}

export async function markSuccess(
  env: Env,
  subscriptionId: number
): Promise<void> {
  await env.DB.prepare(
    `UPDATE subscriptions
     SET last_success_at = CURRENT_TIMESTAMP, failure_count = 0,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(subscriptionId)
    .run();
}

export async function countActiveForSites(
  env: Env,
  siteIds: number[]
): Promise<number> {
  if (siteIds.length === 0) return 0;
  const placeholders = siteIds.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM subscriptions
     WHERE status = 'active' AND site_id IN (${placeholders})`
  )
    .bind(...siteIds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function nextBatchForCampaign(
  env: Env,
  siteIds: number[],
  afterId: number,
  limit: number
): Promise<SubscriptionRow[]> {
  if (siteIds.length === 0) return [];
  const placeholders = siteIds.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT * FROM subscriptions
     WHERE status = 'active' AND site_id IN (${placeholders}) AND id > ?
     ORDER BY id ASC LIMIT ?`
  )
    .bind(...siteIds, afterId, limit)
    .all<SubscriptionRow>();
  return result.results ?? [];
}

export async function purgeOldInactiveSubscriptions(
  env: Env,
  olderThanDays: number
): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM subscriptions
     WHERE status IN ('expired', 'unsubscribed')
       AND updated_at < datetime('now', '-' || ? || ' days')`
  )
    .bind(olderThanDays)
    .run();
  return res.meta.changes ?? 0;
}
