import type { SiteRow } from "../types";

function normalizeDomain(domain: string): string | null {
  try {
    return new URL(
      domain.includes("://") ? domain : `https://${domain}`
    ).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Compute CORS headers for a public endpoint. Only origins registered to the
 * site are allowed; everything else gets no CORS grant.
 */
export function corsHeadersForSite(
  site: SiteRow,
  origin: string | null
): Record<string, string> {
  if (!origin) return {};
  const allowedHosts = new Set<string>();
  const main = normalizeDomain(site.domain);
  if (main) {
    allowedHosts.add(main);
    allowedHosts.add(`www.${main}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return {};
  }
  if (
    parsed.protocol === "https:" &&
    allowedHosts.has(parsed.host.toLowerCase())
  ) {
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  }
  return {};
}

export function preflightResponse(headers: Record<string, string>): Response {
  return new Response(null, { status: 204, headers });
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
