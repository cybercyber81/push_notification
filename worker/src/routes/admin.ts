import type { Route } from "../router";
import {
  authenticateApiKey,
  isAdminRequest,
  jsonError,
} from "../services/auth";
import { jsonResponse } from "../services/cors";
import {
  createSite,
  listSites,
  rotateApiKey,
  setSiteStatus,
} from "../db/sites";

async function requireAdmin(ctx: Parameters<Route["handler"]>[0]): Promise<Response | null> {
  if (!(await isAdminRequest(ctx.req, ctx.env))) return jsonError(403, "forbidden");
  return null;
}

async function createSiteHandler(ctx: Parameters<Route["handler"]>[0]): Promise<Response> {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await ctx.req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid_json");
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  let domain =
    typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
  try {
    domain = new URL(domain.includes("://") ? domain : `https://${domain}`).host;
  } catch {
    return jsonError(400, "invalid_domain");
  }
  if (!name || !domain) return jsonError(400, "name_and_domain_required");

  try {
    const created = await createSite(ctx.env, name, domain);
    return jsonResponse(
      {
        siteKey: created.site.site_key,
        apiKey: created.apiKey,
        vapidPublicKey: created.site.vapid_public_key,
        domain: created.site.domain,
      },
      201
    );
  } catch {
    return jsonError(500, "could_not_create_site");
  }
}

async function listSitesHandler(ctx: Parameters<Route["handler"]>[0]): Promise<Response> {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  return jsonResponse({ sites: await listSites(ctx.env) });
}

async function setSiteStatusHandler(disabledStatus: boolean) {
  return async (ctx: Parameters<Route["handler"]>[0]): Promise<Response> => {
    const denied = await requireAdmin(ctx);
    if (denied) return denied;
    const id = parseInt(ctx.params.id, 10);
    if (!Number.isInteger(id)) return jsonError(400, "invalid_id");
    const ok = await setSiteStatus(
      ctx.env,
      id,
      disabledStatus ? "disabled" : "active"
    );
    if (!ok) return jsonError(404, "not_found");
    return jsonResponse({ ok: true });
  };
}

async function rotateKeyHandler(ctx: Parameters<Route["handler"]>[0]): Promise<Response> {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const id = parseInt(ctx.params.id, 10);
  if (!Number.isInteger(id)) return jsonError(400, "invalid_id");

  const key = await rotateApiKey(ctx.env, id);
  if (!key) return jsonError(404, "not_found_or_rotation_failed");
  return jsonResponse({ apiKey: key }, 201);
}

async function statsHandler(ctx: Parameters<Route["handler"]>[0]): Promise<Response> {
  const siteAuth = await authenticateApiKey(ctx.req, ctx.env);
  const isAdmin = !siteAuth && (await isAdminRequest(ctx.req, ctx.env));
  if (!siteAuth && !isAdmin) return jsonError(401, "unauthorized");

  const db = ctx.env.DB;
  const scope = siteAuth && !isAdmin;

  const [sites, activeSubs, newToday, campaignsToday, deliveryTotals, expired] =
    await Promise.all([
      db.prepare(
        `SELECT COUNT(*) AS n FROM sites${scope ? " WHERE id = ?" : ""}`
      )
        .bind(...(scope ? [siteAuth!.site.id] : []))
        .first<{ n: number }>(),
      db.prepare(
        `SELECT COUNT(*) AS n FROM subscriptions
         WHERE status = 'active'${scope ? " AND site_id = ?" : ""}`
      )
        .bind(...(scope ? [siteAuth!.site.id] : []))
        .first<{ n: number }>(),
      db.prepare(
        `SELECT COUNT(*) AS n FROM subscriptions
         WHERE status = 'active'
           AND created_at >= datetime('now', 'start of day')${
             scope ? " AND site_id = ?" : ""
           }`
      )
        .bind(...(scope ? [siteAuth!.site.id] : []))
        .first<{ n: number }>(),
      db.prepare(
        `SELECT COUNT(*) AS n FROM campaigns
         WHERE created_at >= datetime('now', 'start of day')${
           scope ? " AND site_id = ?" : ""
         }`
      )
        .bind(...(scope ? [siteAuth!.site.id] : []))
        .first<{ n: number }>(),
      db.prepare(
        `SELECT COALESCE(SUM(total_success), 0) AS success,
                COALESCE(SUM(total_failed), 0) AS failed,
                COALESCE(SUM(total_attempted), 0) AS attempted
         FROM campaigns${scope ? " WHERE site_id = ?" : ""}`
      )
        .bind(...(scope ? [siteAuth!.site.id] : []))
        .first<{ success: number; failed: number; attempted: number }>(),
      db.prepare(
        `SELECT COUNT(*) AS n FROM subscriptions
         WHERE status = 'expired'${scope ? " AND site_id = ?" : ""}`
      )
        .bind(...(scope ? [siteAuth!.site.id] : []))
        .first<{ n: number }>(),
    ]);

  const success = deliveryTotals?.success ?? 0;
  const failed = deliveryTotals?.failed ?? 0;
  const attempted = deliveryTotals?.attempted ?? 0;

  return jsonResponse({
    totalSites: sites?.n ?? 0,
    activeSubscriptions: activeSubs?.n ?? 0,
    newSubscriptionsToday: newToday?.n ?? 0,
    campaignsToday: campaignsToday?.n ?? 0,
    deliveriesSuccess: success,
    deliveriesFailed: failed,
    deliveriesAttempted: attempted,
    failureRate: attempted > 0 ? Math.round((failed / attempted) * 10000) / 100 : 0,
    expiredSubscriptions: expired?.n ?? 0,
  });
}

export const adminRoutes: Route[] = [
  { method: "POST", pattern: "/v1/admin/sites", handler: createSiteHandler },
  { method: "GET", pattern: "/v1/admin/sites", handler: listSitesHandler },
  { method: "POST", pattern: "/v1/admin/sites/:id/disable", handler: setSiteStatusHandler(true) },
  { method: "POST", pattern: "/v1/admin/sites/:id/enable", handler: setSiteStatusHandler(false) },
  { method: "POST", pattern: "/v1/admin/sites/:id/rotate-key", handler: rotateKeyHandler },
  { method: "GET", pattern: "/v1/stats", handler: statsHandler },
];
