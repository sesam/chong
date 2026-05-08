import { Hono } from "hono";
import { db } from "../db";
import { deployWorker } from "../cf";
import { Harness } from "../harness";
import { SSEStream } from "../sse";
import type { CL, Env, HonoEnv } from "../types";
import { slugify } from "../util";

export const clsRoutes = new Hono<HonoEnv>();

clsRoutes.post("/", async (c) => {
  const auth = c.var.auth;
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; repo?: string };
  const title = body.title;
  const repo = body.repo;
  if (!title || !repo) {
    return c.json({ error: "title and repo required" }, 400);
  }

  const id = await db.nextCLId(c.env);
  const slug = slugify(title);
  const idLower = id.toLowerCase().replace(/^cl-?/, "");
  const branch = `chong/${auth.user.replace(/[^a-zA-Z0-9._-]/g, "-")}/${idLower}-${slug}`;

  await db.insertCL(c.env, {
    id,
    title,
    repo,
    branch,
    author: auth.user,
    status: "DRAFT",
  });

  const cl = await db.getCL(c.env, id);
  return c.json(cl);
});

clsRoutes.get("/", async (c) => {
  const auth = c.var.auth;
  const status = c.req.query("status") ?? undefined;
  const author = c.req.query("author") ?? auth.user;
  const repo = c.req.query("repo") ?? undefined;
  const list = await db.listCLs(c.env, { author, status, repo });
  return c.json(list);
});

clsRoutes.get("/:id", async (c) => {
  const cl = await db.getCL(c.env, c.req.param("id"));
  if (!cl) return c.json({ error: "not found" }, 404);
  return c.json(cl);
});

clsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const cl = await db.getCL(c.env, id);
  if (!cl) return c.json({ error: "not found" }, 404);
  if (cl.author !== c.var.auth.user) {
    return c.json({ error: "not your CL" }, 403);
  }
  await db.abandonCL(c.env, id);
  return c.json({ ok: true });
});

clsRoutes.post("/:id/upload", async (c) => {
  const id = c.req.param("id");
  const cl = await db.getCL(c.env, id);
  if (!cl) return c.json({ error: "not found" }, 404);
  if (cl.author !== c.var.auth.user) {
    return c.json({ error: "not your CL" }, 403);
  }

  const form = await c.req.formData();
  const script = form.get("worker.js") as Blob | string | null;
  const metaRaw = form.get("metadata") as Blob | string | null;
  if (!script || typeof script === "string") {
    return c.json({ error: "missing worker.js part (must be a file)" }, 400);
  }
  if (!metaRaw) {
    return c.json({ error: "missing metadata part" }, 400);
  }
  const metaText = typeof metaRaw === "string" ? metaRaw : await metaRaw.text();
  const meta = JSON.parse(metaText) as {
    sha: string;
    script_name: string;
    compatibility_date?: string;
    has_fixes?: boolean;
    lint_fixes?: number;
    build_ms?: number;
  };

  const scriptBuf = await script.arrayBuffer();

  const sse = new SSEStream();
  c.executionCtx.waitUntil(runPipeline(c.env, cl, scriptBuf, meta, sse));
  return sse.response;
});

async function runPipeline(
  env: Env,
  cl: CL,
  script: ArrayBuffer,
  meta: {
    sha: string;
    script_name: string;
    compatibility_date?: string;
    has_fixes?: boolean;
    lint_fixes?: number;
    build_ms?: number;
  },
  sse: SSEStream,
): Promise<void> {
  try {
    await db.updateCL(env, cl.id, {
      status: "BUILDING",
      sha: meta.sha,
      lint_fixes: meta.lint_fixes ?? 0,
      build_ms: meta.build_ms ?? null,
    });
    await sse.send("step", `received ${meta.sha.slice(0, 7)} (${(script.byteLength / 1024).toFixed(1)}kB)`);
    if (meta.has_fixes && (meta.lint_fixes ?? 0) > 0) {
      await sse.send("step", `auto-fixed ${meta.lint_fixes} file${meta.lint_fixes === 1 ? "" : "s"} locally`);
    }

    await sse.send("step", "deploying to Cloudflare…");
    const t0 = Date.now();
    const deploy = await deployWorker({
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.CF_API_TOKEN,
      scriptName: meta.script_name,
      scriptModule: script,
      compatibilityDate: meta.compatibility_date,
      workerDomain: env.WORKER_DOMAIN,
    });
    const deployMs = Date.now() - t0;
    await sse.send("done", `deployed in ${deployMs}ms`);

    await sse.send("step", "merging to main…");
    const harness = new Harness(env.HARNESS_URL, env.HARNESS_BOT_PAT);
    const pr = await harness.createPR(cl.repo, {
      title: cl.title,
      description: `chong ${cl.id}`,
      source_branch: cl.branch,
      target_branch: "main",
    });
    const merge = await harness.mergePR(cl.repo, pr.number);
    await sse.send("done", `merged ${merge.sha.slice(0, 7)}`);

    await db.updateCL(env, cl.id, {
      status: "LIVE",
      sha: merge.sha,
      worker_url: deploy.url,
      deploy_id: deploy.deploy_id,
      deploy_ms: deployMs,
    });

    await sse.send("done", `live at ${deploy.url}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sse.send("error", msg);
    await db.updateCL(env, cl.id, { status: "BUILD_ERROR" });
  } finally {
    await sse.close();
  }
}
