import type { Env } from "../types";
import {
  claimLease,
  campaignSiteIds,
  getCampaign,
  recordBatchProgress,
  releaseLease,
} from "../db/campaigns";
import {
  markExpired,
  markSuccess,
  nextBatchForCampaign,
} from "../db/subscriptions";
import { getSiteById } from "../db/sites";
import { decryptSecret } from "./crypto";
import { buildVapidHeader } from "./vapid";
import { sendPush } from "./webpush";

export interface ProcessResult {
  ok: boolean;
  status?: string;
  attempted?: number;
  hasMore?: boolean;
  message?: string;
}

const DONE_STATUSES = new Set(["completed", "cancelled", "failed"]);

/**
 * Process ONE small resumable batch of a campaign.
 * The cursor lives in D1 so any interrupted run can be continued safely.
 */
export async function processCampaignBatch(
  env: Env,
  campaignId: number
): Promise<ProcessResult> {
  const campaign = await getCampaign(env, campaignId);
  if (!campaign) return { ok: false, message: "not_found" };
  if (DONE_STATUSES.has(campaign.status)) {
    return { ok: true, status: campaign.status, hasMore: false };
  }

  const token = await claimLease(env, campaign.id, 120);
  if (!token) return { ok: false, message: "locked" };

  try {
    const batchSize = Math.max(1, parseInt(env.BATCH_SIZE || "5", 10) || 5);
    const siteIds = await campaignSiteIds(env, campaign);
    const batch = await nextBatchForCampaign(
      env,
      siteIds,
      campaign.cursor_subscription_id,
      batchSize
    );

    if (batch.length === 0) {
      await recordBatchProgress(
        env,
        campaign.id,
        {
          attempted: 0,
          success: 0,
          failed: 0,
          lastId: campaign.cursor_subscription_id,
        },
        true
      );
      return { ok: true, status: "completed", attempted: 0, hasMore: false };
    }

    // Per-site VAPID material (decrypted here, never leaves the Worker).
    const vapidCache = new Map<number, { pkcs8: string; publicKey: string } | null>();
    let success = 0;
    let failed = 0;
    let lastId = campaign.cursor_subscription_id;

    for (const sub of batch) {
      lastId = sub.id;

      let vapid = vapidCache.get(sub.site_id);
      if (vapid === undefined) {
        const site = await getSiteById(env, sub.site_id);
        vapid =
          site?.vapid_private_key_encrypted && site.vapid_public_key
            ? {
                pkcs8: await decryptSecret(
                  site.vapid_private_key_encrypted,
                  env.VAPID_MASTER_ENCRYPTION_KEY
                ),
                publicKey: site.vapid_public_key,
              }
            : null;
        vapidCache.set(sub.site_id, vapid);
      }
      if (!vapid) {
        failed++;
        continue;
      }

      // aud depends on the endpoint origin, which varies per browser vendor.
      const vapidAuth = await buildVapidHeader(
        sub.endpoint,
        vapid.pkcs8,
        vapid.publicKey,
        "mailto:push@localhost"
      );

      const outcome = await sendPush(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        {
          title: campaign.title,
          body: campaign.body,
          url: campaign.target_url ?? "/",
          icon: campaign.icon_url ?? undefined,
          badge: campaign.badge_url ?? undefined,
          image: campaign.image_url ?? undefined,
          tag: campaign.tag ?? undefined,
          campaignId: campaign.id,
        },
        vapidAuth
      );

      if (outcome.result === "success") {
        success++;
        await markSuccess(env, sub.id);
      } else {
        failed++;
        if (outcome.result === "gone") {
          await markExpired(env, sub.id);
        }
        // Detailed log for failures only; successes stay aggregate counters.
        await env.DB.prepare(
          `INSERT INTO delivery_log (campaign_id, subscription_id, site_id, response_status, result)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(campaign.id, sub.id, sub.site_id, outcome.status, outcome.result)
          .run()
          .catch(() => {});
      }
    }

    await recordBatchProgress(
      env,
      campaign.id,
      {
        attempted: batch.length,
        success,
        failed,
        lastId,
      },
      false
    );

    return {
      ok: true,
      attempted: batch.length,
      hasMore: batch.length === batchSize,
      status: "processing",
    };
  } finally {
    await releaseLease(env, campaign.id, token);
  }
}
