import type { Env, SiteRow } from "../types";
import { sha256Hex, timingSafeEqual } from "./crypto";

export interface SiteAuth {
  site: SiteRow;
  apiKeyId: number;
}

export function jsonError(status: number, message: string): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** Authenticate a private request via `Authorization: Bearer pp_live_...`. */
export async function authenticateApiKey(
  req: Request,
  env: Env
): Promise<SiteAuth | null> {
  const header = req.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!match) return null;

  const key = match[1];
  if (
    env.ADMIN_AUTH_SECRET &&
    env.ADMIN_AUTH_SECRET.length > 0 &&
    timingSafeEqual(key, env.ADMIN_AUTH_SECRET)
  ) {
    // Admin token is handled separately; never treat it as a site key.
    return null;
  }
  if (key.length < 16 || key.length > 256) return null;

  const hash = await sha256Hex(key);
  const row = await env.DB.prepare(
    `SELECT k.id AS api_key_id, s.*
     FROM site_api_keys k
     JOIN sites s ON s.id = k.site_id
     WHERE k.key_hash = ? AND k.status = 'active' AND s.status = 'active'`
  )
    .bind(hash)
    .first<SiteRow & { api_key_id: number }>();

  if (!row) return null;

  await env.DB.prepare("UPDATE site_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(row.api_key_id)
    .run();

  return { site: row as unknown as SiteRow, apiKeyId: row.api_key_id };
}

export async function isAdminRequest(req: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_AUTH_SECRET) return false;
  const header = req.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return !!match && timingSafeEqual(match[1], env.ADMIN_AUTH_SECRET);
}

/**
 * Validate that the request Origin belongs to the given site.
 * Accepts https://domain and https://www.domain.
 */
export function originAllowed(site: SiteRow, origin: string | null): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.host.toLowerCase();
  const domain = new URL(`https://${site.domain}`).host.toLowerCase();
  return host === domain || host === `www.${domain}`;
}

export interface ValidatedSubscriptionBody {
  endpoint: string;
  p256dh: string;
  auth: string;
  locale?: string | null;
  userAgent?: string | null;
}

export function validateSubscriptionJson(
  body: unknown
): ValidatedSubscriptionBody | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const sub = b.subscription as Record<string, unknown> | undefined;
  const keys = sub?.keys as Record<string, unknown> | undefined;
  if (!sub || !keys) return null;

  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";

  if (!endpoint.startsWith("https://") || endpoint.length > 2048) return null;
  if (!p256dh || p256dh.length > 512 || !auth || auth.length > 512) return null;

  const meta = (b.meta ?? {}) as Record<string, unknown>;
  const locale =
    typeof meta.locale === "string" && meta.locale.length <= 35
      ? meta.locale
      : null;

  return { endpoint, p256dh, auth, locale };
}
