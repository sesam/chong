import { Hono } from "hono";
import { db } from "../db";
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

  const body = (await c.req.json().catch(() => ({}))) as { sha?: string };
  const sha = body.sha;
  if (!sha) {
    return c.json({ error: "sha required" }, 400);
  }

  const sse = new SSEStream();
  c.executionCtx.waitUntil(runPipeline(c.env, cl, sha, sse));
  return sse.response;
});

async function runPipeline(env: Env, cl: CL, sha: string, sse: SSEStream): Promise<void> {
  try {
    await db.updateCL(env, cl.id, { status: "BUILDING", sha });
    await sse.send("step", `received ${sha.slice(0, 7)} on ${cl.branch}`);

    await sse.send("step", "merging to main…");
    const harness = new Harness(env.HARNESS_URL, env.HARNESS_BOT_PAT);
    const pr = await harness.createPR(cl.repo, {
      title: cl.title,
      description: `chong ${cl.id}`,
      source_branch: cl.branch,
      target_branch: "main",
    });
    const merge = await harness.mergePR(cl.repo, pr.number);

    await db.updateCL(env, cl.id, { status: "LIVE", sha: merge.sha });
    await sse.send("done", `merged ${merge.sha.slice(0, 7)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sse.send("error", msg);
    await db.updateCL(env, cl.id, { status: "BUILD_ERROR" });
  } finally {
    await sse.close();
  }
}
