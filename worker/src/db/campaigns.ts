import type { Env, CampaignRow } from "../types";

export interface CreateCampaignInput {
  title: string;
  body: string;
  targetUrl?: string | null;
  iconUrl?: string | null;
  badgeUrl?: string | null;
  imageUrl?: string | null;
  tag?: string | null;
  createdBy?: string | null;
  siteIds: number[];
  scheduledAt?: string | null;
}

export async function createCampaign(
  env: Env,
  input: CreateCampaignInput
): Promise<CampaignRow> {
  const status = input.scheduledAt ? "scheduled" : "queued";
  const res = await env.DB.prepare(
    `INSERT INTO campaigns (
       site_id, created_by, title, body, target_url, icon_url, badge_url,
       image_url, tag, status, scheduled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.siteIds.length === 1 ? input.siteIds[0] : null,
      input.createdBy ?? null,
      input.title,
      input.body,
      input.targetUrl ?? null,
      input.iconUrl ?? null,
      input.badgeUrl ?? null,
      input.imageUrl ?? null,
      input.tag ?? null,
      status,
      input.scheduledAt ?? null
    )
    .run();

  const id = res.meta.last_row_id;
  if (input.siteIds.length > 1) {
    await env.DB.batch(
      input.siteIds.map((siteId) =>
        env.DB.prepare(
          "INSERT INTO campaign_sites (campaign_id, site_id) VALUES (?, ?)"
        ).bind(id, siteId)
      )
    );
  }
  const campaign = await getCampaign(env, id);
  if (!campaign) throw new Error("failed to load created campaign");
  return campaign;
}

export async function getCampaign(
  env: Env,
  id: number
): Promise<CampaignRow | null> {
  return env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(id)
    .first<CampaignRow>();
}

export async function campaignSiteIds(
  env: Env,
  campaign: CampaignRow
): Promise<number[]> {
  if (campaign.site_id !== null && campaign.site_id !== undefined) {
    return [campaign.site_id];
  }
  const rows = await env.DB.prepare(
    "SELECT site_id FROM campaign_sites WHERE campaign_id = ?"
  )
    .bind(campaign.id)
    .all<{ site_id: number }>();
  return (rows.results ?? []).map((r) => r.site_id);
}

export async function startCampaign(env: Env, id: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE campaigns
     SET status = 'processing', started_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('draft', 'queued')`
  )
    .bind(id)
    .run();
  return res.meta.changes > 0;
}

export interface BatchOutcome {
  attempted: number;
  success: number;
  failed: number;
  lastId: number;
}

export async function recordBatchProgress(
  env: Env,
  campaignId: number,
  outcome: BatchOutcome,
  finished: boolean
): Promise<void> {
  if (finished) {
    await env.DB.prepare(
      `UPDATE campaigns
       SET total_attempted = total_attempted + ?,
           total_success = total_success + ?,
           total_failed = total_failed + ?,
           cursor_subscription_id = ?,
           status = 'completed',
           lease_token = NULL,
           lease_expires_at = NULL,
           finished_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(
        outcome.attempted,
        outcome.success,
        outcome.failed,
        outcome.lastId,
        campaignId
      )
      .run();
    return;
  }

  await env.DB.prepare(
    `UPDATE campaigns
     SET total_attempted = total_attempted + ?,
         total_success = total_success + ?,
         total_failed = total_failed + ?,
         cursor_subscription_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(
      outcome.attempted,
      outcome.success,
      outcome.failed,
      outcome.lastId,
      campaignId
    )
    .run();
}

/**
 * Claim a short processing lease so two concurrent processors cannot send the
 * same batch. Returns a token when claimed.
 */
export async function claimLease(
  env: Env,
  campaignId: number,
  leaseSeconds: number
): Promise<string | null> {
  const token = crypto.randomUUID();
  const res = await env.DB.prepare(
    `UPDATE campaigns
     SET lease_token = ?, lease_expires_at = datetime('now', '+' || ? || ' seconds'),
         status = CASE WHEN status = 'queued' THEN 'processing' ELSE status END,
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND status IN ('queued', 'processing')
       AND (lease_expires_at IS NULL OR lease_expires_at < datetime('now'))`
  )
    .bind(token, leaseSeconds, campaignId)
    .run();
  if (res.meta.changes === 0) return null;
  return token;
}

export async function releaseLease(
  env: Env,
  campaignId: number,
  token: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE campaigns SET lease_token = NULL, lease_expires_at = NULL
     WHERE id = ? AND lease_token = ?`
  )
    .bind(campaignId, token)
    .run();
}

export async function dueScheduledCampaigns(
  env: Env,
  limit: number
): Promise<CampaignRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM campaigns
     WHERE status = 'scheduled' AND scheduled_at <= datetime('now')
     ORDER BY id ASC LIMIT ?`
  )
    .bind(limit)
    .all<CampaignRow>();
  return result.results ?? [];
}

export async function listCampaigns(
  env: Env,
  limit: number
): Promise<
  Array<{
    id: number;
    title: string;
    status: string;
    total_targets: number;
    total_attempted: number;
    total_success: number;
    total_failed: number;
    created_at: string;
    finished_at: string | null;
  }>
> {
  const result = await env.DB.prepare(
    `SELECT id, title, status, total_targets, total_attempted, total_success,
            total_failed, created_at, finished_at
     FROM campaigns ORDER BY id DESC LIMIT ?`
  )
    .bind(limit)
    .all<{
      id: number;
      title: string;
      status: string;
      total_targets: number;
      total_attempted: number;
      total_success: number;
      total_failed: number;
      created_at: string;
      finished_at: string | null;
    }>();
  return result.results ?? [];
}
