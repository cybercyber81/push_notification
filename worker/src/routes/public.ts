import type { Route } from "../router";
import { jsonError, originAllowed, validateSubscriptionJson } from "../services/auth";
import {
  corsHeadersForSite,
  jsonResponse,
  preflightResponse,
} from "../services/cors";
import { getSiteByKey } from "../db/sites";
import {
  unsubscribeByEndpoint,
  upsertSubscription,
} from "../db/subscriptions";

async function preflight(ctx: Parameters<Route["handler"]>[0]): Promise<Response> {
  const siteKey = ctx.url.searchParams.get("site") || "";
  if (!siteKey) return new Response(null, { status: 204 });
  const site = await getSiteByKey(ctx.env, siteKey);
  if (!site) return new Response(null, { status: 204 });
  return preflightResponse(
    corsHeadersForSite(site, ctx.req.headers.get("Origin"))
  );
}

async function publicConfig(
  ctx: Parameters<Route["handler"]>[0]
): Promise<Response> {
  const siteKey = ctx.url.searchParams.get("site") || "";
  if (!siteKey || siteKey.length > 100) return jsonError(400, "invalid_site");

  const site = await getSiteByKey(ctx.env, siteKey);
  if (!site || site.status !== "active")
    return jsonError(404, "site_not_found");

  return jsonResponse(
    { siteKey: site.site_key, enabled: true, vapidPublicKey: site.vapid_public_key },
    200,
    corsHeadersForSite(site, ctx.req.headers.get("Origin"))
  );
}

async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error("body_too_large");
  }

  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new Error("body_too_large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid_json");
  }
}

async function subscribe(ctx: Parameters<Route["handler"]>[0]): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(
      ctx.req,
      parseInt(ctx.env.MAX_BODY_BYTES || "8192", 10)
    );
  } catch (e) {
    return jsonError(400, e instanceof Error ? e.message : "bad_request");
  }

  const parsed = body as Record<string, unknown> | null;
  const siteKey =
    typeof parsed?.siteKey === "string" ? parsed.siteKey.slice(0, 100) : "";
  if (!siteKey) return jsonError(400, "missing_site_key");

  const data = validateSubscriptionJson(body);
  if (!data) return jsonError(400, "invalid_subscription");

  const site = await getSiteByKey(ctx.env, siteKey);
  if (!site || site.status !== "active") return jsonError(404, "site_not_found");

  // Strict origin check: the browser origin must match the registered domain.
  if (!originAllowed(site, ctx.req.headers.get("Origin"))) {
    return jsonError(403, "origin_not_allowed");
  }

  data.userAgent = ctx.req.headers.get("User-Agent")?.slice(0, 255) ?? null;

  const result = await upsertSubscription(ctx.env, site.id, data);
  if (!result.ok) return jsonError(500, "storage_error");

  return jsonResponse({ ok: true }, 200, corsHeadersForSite(site, ctx.req.headers.get("Origin")));
}

async function unsubscribe(ctx: Parameters<Route["handler"]>[0]): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(
      ctx.req,
      parseInt(ctx.env.MAX_BODY_BYTES || "8192", 10)
    );
  } catch (e) {
    return jsonError(400, e instanceof Error ? e.message : "bad_request");
  }

  const b = body as Record<string, unknown>;
  const siteKey = typeof b?.siteKey === "string" ? b.siteKey.slice(0, 100) : "";
  const endpoint =
    typeof b?.endpoint === "string" && b.endpoint.startsWith("https://")
      ? b.endpoint
      : "";
  if (!siteKey || !endpoint) return jsonError(400, "invalid_request");

  const site = await getSiteByKey(ctx.env, siteKey);
  if (!site || site.status !== "active") return jsonError(404, "site_not_found");
  if (!originAllowed(site, ctx.req.headers.get("Origin")))
    return jsonError(403, "origin_not_allowed");

  await unsubscribeByEndpoint(ctx.env, site.id, endpoint);
  return jsonResponse({ ok: true }, 200, corsHeadersForSite(site, ctx.req.headers.get("Origin")));
}

async function recordEvent(ctx: Parameters<Route["handler"]>[0]): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(
      ctx.req,
      parseInt(ctx.env.MAX_BODY_BYTES || "8192", 10)
    );
  } catch (e) {
    return jsonError(400, e instanceof Error ? e.message : "bad_request");
  }

  const b = body as Record<string, unknown>;
  const siteKey = typeof b?.siteKey === "string" ? b.siteKey.slice(0, 100) : "";
  const eventType =
    typeof b?.event === "string" && b.event.length <= 50 ? b.event : "";
  if (!siteKey || !eventType) return jsonError(400, "invalid_event");

  const site = await getSiteByKey(ctx.env, siteKey);
  if (!site || site.status !== "active") return jsonError(404, "site_not_found");
  if (!originAllowed(site, ctx.req.headers.get("Origin")))
    return jsonError(403, "origin_not_allowed");

  const campaignId =
    typeof b.campaignId === "number" && Number.isInteger(b.campaignId)
      ? b.campaignId
      : null;
  const url = typeof b.url === "string" ? b.url.slice(0, 2048) : null;

  await ctx.env.DB.prepare(
    `INSERT INTO events (site_id, campaign_id, event_type, url)
     VALUES (?, ?, ?, ?)`
  )
    .bind(site.id, campaignId, eventType, url)
    .run()
    .catch(() => {});

  return jsonResponse({ ok: true }, 200, corsHeadersForSite(site, ctx.req.headers.get("Origin")));
}

export const publicRoutes: Route[] = [
  { method: "OPTIONS", pattern: "/v1/public/config", handler: preflight },
  { method: "OPTIONS", pattern: "/v1/subscriptions", handler: preflight },
  { method: "OPTIONS", pattern: "/v1/subscriptions/remove", handler: preflight },
  { method: "OPTIONS", pattern: "/v1/events", handler: preflight },
  { method: "GET", pattern: "/v1/public/config", handler: publicConfig },
  { method: "POST", pattern: "/v1/subscriptions", handler: subscribe },
  { method: "POST", pattern: "/v1/subscriptions/remove", handler: unsubscribe },
  { method: "POST", pattern: "/v1/events", handler: recordEvent },
];
