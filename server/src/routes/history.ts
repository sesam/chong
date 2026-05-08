import { Hono } from "hono";
import { generateCoaching } from "../coaching";
import { db } from "../db";
import { Harness } from "../harness";
import type { HonoEnv } from "../types";

export const historyRoutes = new Hono<HonoEnv>();

historyRoutes.get("/history", async (c) => {
  const repo = c.req.query("repo");
  const author = c.req.query("author") ?? undefined;
  const limit = Number(c.req.query("limit") ?? "50");

  if (repo) {
    const harness = new Harness(c.env.HARNESS_URL, c.var.auth.pat);
    const commits = await harness.listCommits(repo, { branch: "main", limit, author });
    const list = await Promise.all(
      commits.map(async (commit) => {
        const cl = await db.getCLBySha(c.env, commit.sha);
        const subject = (commit.title ?? commit.message ?? "").split("\n")[0];
        return {
          sha: commit.sha,
          repo,
          author:
            commit.author?.identity?.email ??
            commit.author?.identity?.name ??
            cl?.author ??
            "unknown",
          message: subject,
          cl_id: cl?.id ?? null,
          date: commit.author?.when ?? commit.committer?.when ?? "",
        };
      }),
    );
    return c.json(list);
  }

  const recent = await db.listCLs(c.env, { status: "LIVE" });
  return c.json(
    recent.map((cl) => ({
      sha: cl.sha,
      repo: cl.repo,
      author: cl.author,
      message: cl.title,
      cl_id: cl.id,
      date: cl.updated_at,
    })),
  );
});

historyRoutes.get("/commit/:sha", async (c) => {
  const sha = c.req.param("sha");
  const repo = c.req.query("repo");
  if (!repo) return c.json({ error: "repo query param required" }, 400);

  const harness = new Harness(c.env.HARNESS_URL, c.var.auth.pat);
  const [commit, diff] = await Promise.all([
    harness.getCommit(repo, sha),
    harness.getDiff(repo, sha),
  ]);
  const message = commit.message ?? commit.title ?? "";

  let coaching = await db.getCoaching(c.env, sha);
  if (!coaching) {
    coaching = await generateCoaching(c.env.ANTHROPIC_API_KEY, {
      sha,
      repo,
      message,
      diff,
    });
    c.executionCtx.waitUntil(db.putCoaching(c.env, sha, repo, coaching));
  }

  return c.json({
    commit: {
      sha,
      repo,
      author: commit.author?.identity?.email ?? commit.author?.identity?.name ?? "unknown",
      message,
      date: commit.author?.when ?? commit.committer?.when ?? "",
    },
    diff,
    coaching,
  });
});

historyRoutes.get("/stats", async (c) => {
  const s = await db.stats(c.env);
  return c.json(s);
});
