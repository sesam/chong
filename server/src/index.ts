import { Hono } from "hono";
import { cors } from "hono/cors";
import { harnessAuth } from "./auth";
import { clsRoutes } from "./routes/cls";
import { historyRoutes } from "./routes/history";
import type { HonoEnv } from "./types";

const app = new Hono<HonoEnv>();
app.use("*", cors());

// Public — does not validate auth.
app.get("/api/health", async (c) => {
  const harnessOk = await fetch(`${c.env.HARNESS_URL.replace(/\/+$/, "")}/api/v1/system/health`)
    .then((r) => r.ok)
    .catch(() => false);
  const cfOk = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { authorization: `Bearer ${c.env.CF_API_TOKEN}` },
  })
    .then((r) => r.ok)
    .catch(() => false);
  return c.json({ ok: harnessOk && cfOk, harness: harnessOk, cloudflare: cfOk });
});

// Authed routes
const authed = new Hono<HonoEnv>();
authed.use("*", harnessAuth());
authed.route("/cls", clsRoutes);
authed.route("/", historyRoutes);
app.route("/api", authed);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
