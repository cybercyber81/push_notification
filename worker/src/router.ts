import type { Env } from "./types";
import { jsonError } from "./services/auth";
import { publicRoutes } from "./routes/public";
import { campaignRoutes } from "./routes/campaigns";
import { internalRoutes } from "./routes/internal";
import { adminRoutes } from "./routes/admin";

export interface Ctx {
  req: Request;
  url: URL;
  env: Env;
  params: Record<string, string>;
  exec: ExecutionContext;
}

export interface Route {
  method: string;
  pattern: string;
  handler: (ctx: Ctx) => Promise<Response>;
}

const routes: Route[] = [
  ...publicRoutes,
  ...campaignRoutes,
  ...internalRoutes,
  ...adminRoutes,
];

function matchPattern(
  pattern: string,
  path: string
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(pathParts[i]);
      } catch {
        return null;
      }
    } else if (p !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function withSecurityHeaders(response: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

export async function handleRequest(
  req: Request,
  env: Env,
  exec: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return withSecurityHeaders(
      Response.json({ ok: true, service: "push-platform" })
    );
  }

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const params = matchPattern(route.pattern, url.pathname);
    if (!params) continue;

    try {
      return withSecurityHeaders(
        await route.handler({ req, url, env, params, exec })
      );
    } catch (err) {
      console.error("handler_error", url.pathname, err);
      return withSecurityHeaders(jsonError(500, "internal_error"));
    }
  }

  return withSecurityHeaders(jsonError(404, "not_found"));
}
