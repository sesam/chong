#!/usr/bin/env bun
import { authenticate } from "./auth";
import { config } from "./config";
import { createCL, deleteCL, getCL, listCLs, uploadCL } from "./routes/cls";
import { handleGitHttp } from "./routes/git-http";
import { listHistory, showCommit } from "./routes/history";
import { jsonErr } from "./util";

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Public health check.
  if (path === "/api/health") {
    return Response.json({ ok: true, time: new Date().toISOString() });
  }

  // Git smart HTTP: /repos/<repo>.git/<sub>
  // Cloudflare Tunnel + Cloudflare Access in front handles dev auth.
  // (For per-user HTTP basic, add a check here in v0.2.)
  const gitMatch = path.match(/^\/repos\/([^/]+\.git)(\/.*)$/);
  if (gitMatch) {
    return await handleGitHttp(req, `/${gitMatch[1]}${gitMatch[2]}`);
  }

  // Authed chong API.
  if (path.startsWith("/api/")) {
    const auth = authenticate(req);
    if (!auth) return jsonErr(401, "unauthorized");

    if (path === "/api/cls" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { title?: string; repo?: string };
      return await createCL(auth, body);
    }
    if (path === "/api/cls" && req.method === "GET") {
      return listCLs(auth, url.searchParams);
    }

    const idMatch = path.match(/^\/api\/cls\/([^/]+)(\/upload)?$/);
    if (idMatch) {
      const id = idMatch[1] ?? "";
      const suffix = idMatch[2];
      if (suffix === "/upload" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { sha?: string };
        return uploadCL(auth, id, body);
      }
      if (req.method === "GET") return getCL(id);
      if (req.method === "DELETE") return deleteCL(auth, id);
    }

    if (path === "/api/history" && req.method === "GET") {
      return await listHistory(url.searchParams);
    }

    const commitMatch = path.match(/^\/api\/commit\/([^/]+)$/);
    if (commitMatch && req.method === "GET") {
      return await showCommit(commitMatch[1] ?? "", url.searchParams);
    }
  }

  return jsonErr(404, "not found");
}

const server = Bun.serve({
  port: config.port,
  hostname: config.bind,
  fetch: handler,
  error(err: Error) {
    console.error(err);
    return jsonErr(500, err.message);
  },
});

console.log(`chong-pi listening on http://${server.hostname}:${server.port}`);
console.log(`data dir: ${config.dataDir}`);
if (!config.anthropicApiKey) {
  console.log("(no ANTHROPIC_API_KEY — coaching disabled)");
}
