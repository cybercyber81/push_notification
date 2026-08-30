import type { Env, SiteRow } from "../types";
import { encryptSecret, randomToken, sha256Hex } from "../services/crypto";
import { generateVapidKeypair } from "../services/vapid";

export async function getSiteByKey(
  env: Env,
  siteKey: string
): Promise<SiteRow | null> {
  return env.DB.prepare(
    "SELECT * FROM sites WHERE site_key = ?"
  )
    .bind(siteKey)
    .first<SiteRow>();
}

export async function getSiteById(
  env: Env,
  id: number
): Promise<SiteRow | null> {
  return env.DB.prepare("SELECT * FROM sites WHERE id = ?")
    .bind(id)
    .first<SiteRow>();
}

export interface CreatedSite {
  site: SiteRow;
  apiKey: string;
}

/**
 * Create a site with its own VAPID identity and hashed API key.
 * The raw API key is returned exactly once.
 */
export async function createSite(
  env: Env,
  name: string,
  domain: string,
  siteKey?: string
): Promise<CreatedSite> {
  const vapid = await generateVapidKeypair();
  const master = env.VAPID_MASTER_ENCRYPTION_KEY;
  const encryptedPrivateKey = await encryptSecret(
    vapid.privateKeyPkcs8,
    master
  );

  const key = `pp_live_${randomToken(30)}`;
  const prefix = key.slice(0, 12);
  const hash = await sha256Hex(key);

  const finalKey =
    siteKey && /^[a-z0-9_]{2,64}$/.test(siteKey)
      ? siteKey
      : `site_${randomToken(6).toLowerCase()}`;

  let result;
  try {
    result = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sites (site_key, name, domain, status, vapid_public_key, vapid_private_key_encrypted)
         VALUES (?, ?, ?, 'active', ?, ?)`
      ).bind(finalKey, name, domain, vapid.publicKey, encryptedPrivateKey),
      // site id is needed for the api key row; use last_insert_rowid via subselect
      env.DB.prepare(
        `INSERT INTO site_api_keys (site_id, key_prefix, key_hash, status)
         VALUES ((SELECT id FROM sites WHERE site_key = ?), ?, ?, 'active')`
      ).bind(finalKey, prefix, hash),
    ]);
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed: sites.domain")) {
      throw new Error("domain_conflict");
    }
    throw err;
  }

  if (!result[0].success || !result[1].success) {
    throw new Error("failed to create site");
  }

  const site = await getSiteByKey(env, finalKey);
  if (!site) throw new Error("failed to load created site");
  return { site, apiKey: key };
}

export async function listSites(env: Env): Promise<
  Array<{
    id: number;
    site_key: string;
    name: string;
    domain: string;
    status: string;
    subscribers: number;
    created_at: string;
  }>
> {
  const result = await env.DB.prepare(
    `SELECT s.id, s.site_key, s.name, s.domain, s.status, s.created_at,
            (SELECT COUNT(*) FROM subscriptions sub
              WHERE sub.site_id = s.id AND sub.status = 'active') AS subscribers
     FROM sites s ORDER BY s.id ASC`
  )
    .all<{
      id: number;
      site_key: string;
      name: string;
      domain: string;
      status: string;
      subscribers: number;
      created_at: string;
    }>();
  return result.results ?? [];
}

export async function setSiteStatus(
  env: Env,
  siteId: number,
  status: "active" | "disabled"
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE sites SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  )
    .bind(status, siteId)
    .run();
  return res.meta.changes > 0;
}

/** Issue a fresh API key for a site; returns the raw key once. */
export async function rotateApiKey(
  env: Env,
  siteId: number
): Promise<string | null> {
  const site = await getSiteById(env, siteId);
  if (!site) return null;

  const key = `pp_live_${randomToken(30)}`;
  const prefix = key.slice(0, 12);
  const hash = await sha256Hex(key);

  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE site_api_keys SET status = 'revoked' WHERE site_id = ? AND status = 'active'"
    ).bind(siteId),
    env.DB.prepare(
      "INSERT INTO site_api_keys (site_id, key_prefix, key_hash, status) VALUES (?, ?, ?, 'active')"
    ).bind(siteId, prefix, hash),
  ]);
  if (!results[1].success) return null;
  return key;
}
