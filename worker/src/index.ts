import type { Env } from "./types";
import { handleRequest } from "./router";
import { dueScheduledCampaigns, startCampaign } from "./db/campaigns";
import { purgeOldInactiveSubscriptions } from "./db/subscriptions";
import { processCampaignBatch } from "./services/campaign";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error("unhandled_error", err);
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
    }
  },

  /**
   * Single cron (every 5 minutes): starts due scheduled campaigns and runs
   * housekeeping. Each started campaign processes one batch here; the
   * internal self-chaining endpoint drains the rest.
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const due = await dueScheduledCampaigns(env, 5);
          for (const campaign of due) {
            const started = await startCampaign(env, campaign.id);
            if (!started) continue;

            if (env.SELF_BASE_URL && env.INTERNAL_JOB_SECRET) {
              // Kick off self-chaining; each chain step is its own invocation.
              ctx.waitUntil(
                fetch(
                  `${env.SELF_BASE_URL.replace(/\/$/, "")}/v1/internal/process?campaign_id=${campaign.id}`,
                  {
                    method: "POST",
                    headers: { Authorization: `Bearer ${env.INTERNAL_JOB_SECRET}` },
                  }
                ).catch(() => {})
              );
            } else {
              // Fallback without SELF_BASE_URL: process one batch per cron tick.
              ctx.waitUntil(
                processCampaignBatch(env, campaign.id)
                  .then(() => {})
                  .catch(() => {})
              );
            }
          }

          await purgeOldInactiveSubscriptions(env, 90);
        } catch (err) {
          console.error("scheduled_error", err);
        }
      })()
    );
  },
};
