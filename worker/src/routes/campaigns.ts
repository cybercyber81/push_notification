import type { Route } from "../router";
import type { SiteRow } from "../types";
import {
  authenticateApiKey,
  isAdminRequest,
  jsonError,
} from "../services/auth";
import { jsonResponse } from "../services/cors";
import { sha256Hex } from "../services/crypto";
import { getSiteByKey } from "../db/sites";
import { countActiveForSites } from "../db/subscriptions";
import {
  createCampaign,
  getCampaign,
  campaignSiteIds,
  startCampaign,
} from "../db/campaigns";
import { processCampaignBatch } from "../services/campaign";

interface Caller {
  site: SiteRow | null;
  isAdmin: boolean;
}

async function identifyCaller(ctx: Parameters<Route["handler"]>[0]): Promise<Caller | null> {
  const siteAuth = await authenticateApiKey(ctx.req, ctx.env);
  if (siteAuth) return { site: siteAuth.site, isAdmin: false };
  if (await isAdminRequest(ctx.req, ctx.env)) return { site: null, isAdmin: true };
  return null;
}

async function canAccessCampaign(
  ctx: Parameters<Route["handler"]>[0],
  caller: Caller,
  campaignId: number
): Promise<boolean> {
  if (caller.isAdmin) return true;
  const row = await ctx.env.DB.prepare(
    `SELECT 1 AS ok FROM campaigns c
     WHERE c.id = ?
       AND (c.site_id = ? OR EXISTS (
         SELECT 1 FROM campaign_sites cs WHERE cs.campaign_id = c.id AND cs.site_id = ?
       ))`
  )
    .bind(campaignId, caller.site!.id, caller.site!.id)
    .first<{ ok: number }>();
  return !!row;
}

function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  try {
    const u = new URL(value);
    if (u.href.length > 2048) return null;
    return u.href;
  } catch {
    return null;
  }
}

async function createCampaignHandler(
  ctx: Parameters<Route["handler"]>[0]
): Promise<Response> {
  const caller = await identifyCaller(ctx);
  if (!caller) return jsonError(401, "unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await ctx.req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid_json");
  }

  const title =
    typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const message =
    typeof body.body === "string" ? body.body.trim().slice(0, 500) : "";
  if (!title || !message) return jsonError(400, "title_and_body_required");

  const targetUrl = httpsUrlOrNull(body.url ?? body.target_url);
  const iconUrl = httpsUrlOrNull(body.icon);
  const badgeUrl = httpsUrlOrNull(body.badge);
  const imageUrl = httpsUrlOrNull(body.image);
  const tag =
    typeof body.tag === "string" && body.tag.length <= 100 ? body.tag : null;
  const scheduledAt =
    typeof body.scheduledAt === "string" &&
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(body.scheduledAt)
      ? body.scheduledAt.replace("T", " ") + (body.scheduledAt.length === 16 ? ":00" : "")
      : null;

  // Resolve target sites. API-key callers are always pinned to their own site.
  let siteIds: number[] = [];
  if (!caller.isAdmin) {
    siteIds = [caller.site!.id];
  } else {
    const keys = Array.isArray(body.siteKeys)
      ? (body.siteKeys as unknown[]).filter(
          (k): k is string => typeof k === "string"
        )
      : [];
    for (const key of keys.slice(0, 50)) {
      const site = await getSiteByKey(ctx.env, key);
      if (site && site.status === "active") siteIds.push(site.id);
    }
  }
  if (siteIds.length === 0) return jsonError(400, "no_valid_target_sites");

  // Idempotency support.
  const idemHeader = ctx.req.headers.get("Idempotency-Key");
  let idemKeyHash: string | null = null;
  if (idemHeader && idemHeader.length <= 200) {
    idemKeyHash = await sha256Hex(`${caller.isAdmin ? "admin" : caller.site!.site_key}:${idemHeader}`);
    const existing = await ctx.env.DB.prepare(
      "SELECT response_json FROM idempotency_keys WHERE key = ?"
    )
      .bind(idemKeyHash)
      .first<{ response_json: string }>();
    if (existing?.response_json) {
      return new Response(existing.response_json, {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Idempotent-Replay": "true" },
      });
    }
  }

  const totalTargets = await countActiveForSites(ctx.env, siteIds);
  const campaign = await createCampaign(ctx.env, {
    title,
    body: message,
    targetUrl,
    iconUrl,
    badgeUrl,
    imageUrl,
    tag,
    createdBy: caller.isAdmin ? "admin" : caller.site!.site_key,
    siteIds,
    scheduledAt,
  });

  if (totalTargets > 0) {
    await ctx.env.DB.prepare(
      "UPDATE campaigns SET total_targets = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
      .bind(totalTargets, campaign.id)
      .run();
  }

  const responseBody = JSON.stringify({ id: campaign.id, status: campaign.status });
  if (idemKeyHash) {
    await ctx.env.DB.prepare(
      `INSERT INTO idempotency_keys (key, site_id, response_json)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`
    )
      .bind(idemKeyHash, caller.isAdmin ? 0 : caller.site!.id, responseBody)
      .run()
      .catch(() => {});
  }

  return new Response(responseBody, {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

async function getCampaignHandler(
  ctx: Parameters<Route["handler"]>[0]
): Promise<Response> {
  const caller = await identifyCaller(ctx);
  if (!caller) return jsonError(401, "unauthorized");

  const id = parseInt(ctx.params.id, 10);
  if (!Number.isInteger(id)) return jsonError(400, "invalid_id");
  if (!(await canAccessCampaign(ctx, caller, id)))
    return jsonError(404, "not_found");

  const campaign = await getCampaign(ctx.env, id);
  if (!campaign) return jsonError(404, "not_found");

  return jsonResponse({
    id: campaign.id,
    status: campaign.status,
    totalTargets: campaign.total_targets,
    attempted: campaign.total_attempted,
    success: campaign.total_success,
    failed: campaign.total_failed,
  });
}

async function startCampaignHandler(
  ctx: Parameters<Route["handler"]>[0]
): Promise<Response> {
  const caller = await identifyCaller(ctx);
  if (!caller) return jsonError(401, "unauthorized");

  const id = parseInt(ctx.params.id, 10);
  if (!Number.isInteger(id)) return jsonError(400, "invalid_id");
  if (!(await canAccessCampaign(ctx, caller, id)))
    return jsonError(404, "not_found");

  const started = await startCampaign(ctx.env, id);
  if (!started) return jsonError(409, "cannot_start_from_current_status");
  return jsonResponse({ ok: true, id, status: "processing" });
}

/** One resumable batch per call; dashboard loops while hasMore=true. */
async function processCampaignHandler(
  ctx: Parameters<Route["handler"]>[0]
): Promise<Response> {
  const caller = await identifyCaller(ctx);
  if (!caller) return jsonError(401, "unauthorized");

  const id = parseInt(ctx.params.id, 10);
  if (!Number.isInteger(id)) return jsonError(400, "invalid_id");
  if (!(await canAccessCampaign(ctx, caller, id)))
    return jsonError(404, "not_found");

  const result = await processCampaignBatch(ctx.env, id);
  if (!result.ok) return jsonError(result.message === "locked" ? 409 : 400, result.message ?? "error");
  return jsonResponse(result);
}

async function listCampaignsHandler(
  ctx: Parameters<Route["handler"]>[0]
): Promise<Response> {
  const auth = await authenticateApiKey(ctx.req, ctx.env);
  if (!auth && !(await isAdminRequest(ctx.req, ctx.env)))
    return jsonError(401, "unauthorized");

  let rows;
  if (auth) {
    rows = await ctx.env.DB.prepare(
      `SELECT id, title, status, total_targets, total_attempted, total_success,
              total_failed, created_at, finished_at
       FROM campaigns
       WHERE site_id = ? OR EXISTS (
         SELECT 1 FROM campaign_sites cs WHERE cs.campaign_id = campaigns.id AND cs.site_id = ?
       )
       ORDER BY id DESC LIMIT 100`
    )
      .bind(auth.site.id, auth.site.id)
      .all();
  } else {
    rows = await ctx.env.DB.prepare(
      `SELECT id, title, status, total_targets, total_attempted, total_success,
              total_failed, created_at, finished_at
       FROM campaigns ORDER BY id DESC LIMIT 100`
    ).all();
  }

  return jsonResponse({ campaigns: rows.results ?? [] });
}

export const campaignRoutes: Route[] = [
  { method: "POST", pattern: "/v1/campaigns", handler: createCampaignHandler },
  { method: "GET", pattern: "/v1/campaigns", handler: listCampaignsHandler },
  { method: "GET", pattern: "/v1/campaigns/:id", handler: getCampaignHandler },
  { method: "POST", pattern: "/v1/campaigns/:id/start", handler: startCampaignHandler },
  { method: "POST", pattern: "/v1/campaigns/:id/process", handler: processCampaignHandler },
];
