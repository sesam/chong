import type { MiddlewareHandler } from "hono";
import type { HonoEnv } from "./types";

export function harnessAuth(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const h = c.req.header("authorization");
    if (!h?.startsWith("Bearer ")) {
      return c.json({ error: "missing bearer token" }, 401);
    }
    const pat = h.slice(7);
    const r = await fetch(`${c.env.HARNESS_URL.replace(/\/+$/, "")}/api/v1/user`, {
      headers: { authorization: `Bearer ${pat}` },
    });
    if (!r.ok) return c.json({ error: "invalid token" }, 401);
    const u = (await r.json()) as { uid?: string; email?: string; display_name?: string };
    const user = u.uid ?? u.email ?? u.display_name ?? "unknown";
    c.set("auth", { user, pat });
    await next();
  };
}
