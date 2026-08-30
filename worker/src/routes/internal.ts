import type { Route } from "../router";
import { jsonError } from "../services/auth";
import { jsonResponse } from "../services/cors";
import { timingSafeEqual } from "../services/crypto";
import { processCampaignBatch } from "../services/campaign";

/**
 * Internal self-chaining batch processor.
 * After each batch with more work, the Worker re-invokes itself so a campaign
 * drains without any browser tab being open. Protected by INTERNAL_JOB_SECRET.
 */
async function internalProcess(
  ctx: Parameters<Route["handler"]>[0]
): Promise<Response> {
  const header = ctx.req.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (
    !match ||
    !ctx.env.INTERNAL_JOB_SECRET ||
    !timingSafeEqual(match[1], ctx.env.INTERNAL_JOB_SECRET)
  ) {
    return jsonError(403, "forbidden");
  }

  const id = parseInt(ctx.url.searchParams.get("campaign_id") || "", 10);
  if (!Number.isInteger(id)) return jsonError(400, "invalid_campaign_id");

  const result = await processCampaignBatch(ctx.env, id);
  if (!result.ok) {
    // "locked" just means another processor is active; not an error to retry later.
    if (result.message === "locked") return jsonResponse({ ok: true, locked: true });
    return jsonError(400, result.message ?? "error");
  }

  if (result.hasMore) {
    ctx.exec.waitUntil(
      fetch(`${ctx.url.origin}/v1/internal/process?campaign_id=${id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.env.INTERNAL_JOB_SECRET}` },
      }).catch((err) => console.error("self_chain_fetch_error", id, err))
    );
  }

  return jsonResponse(result);
}

export const internalRoutes: Route[] = [
  { method: "POST", pattern: "/v1/internal/process", handler: internalProcess },
];
