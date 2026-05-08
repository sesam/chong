import type { CL, Env } from "./types";

export const db = {
  async nextCLId(env: Env): Promise<string> {
    const r = await env.DB.prepare(
      `INSERT INTO counters (name, value) VALUES ('cl', 1)
       ON CONFLICT(name) DO UPDATE SET value = counters.value + 1
       RETURNING value`,
    ).first<{ value: number }>();
    if (!r) throw new Error("failed to allocate CL id");
    return `CL-${String(r.value).padStart(3, "0")}`;
  },

  async insertCL(
    env: Env,
    cl: Pick<CL, "id" | "title" | "repo" | "branch" | "author"> & { status: CL["status"] },
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO cls (id, title, repo, branch, author, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
      .bind(cl.id, cl.title, cl.repo, cl.branch, cl.author, cl.status)
      .run();
  },

  async getCL(env: Env, id: string): Promise<CL | null> {
    const r = await env.DB.prepare(`SELECT * FROM cls WHERE id = ?`).bind(id).first<CL>();
    return r ?? null;
  },

  async getCLBySha(env: Env, sha: string): Promise<CL | null> {
    const r = await env.DB.prepare(`SELECT * FROM cls WHERE sha = ?`).bind(sha).first<CL>();
    return r ?? null;
  },

  async listCLs(
    env: Env,
    q: { author?: string; status?: string; repo?: string },
  ): Promise<CL[]> {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.author) {
      where.push("author = ?");
      args.push(q.author);
    }
    if (q.status) {
      where.push("status = ?");
      args.push(q.status);
    }
    if (q.repo) {
      where.push("repo = ?");
      args.push(q.repo);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const stmt = env.DB.prepare(
      `SELECT * FROM cls ${whereSql} ORDER BY created_at DESC LIMIT 200`,
    );
    const result = await (args.length > 0 ? stmt.bind(...args) : stmt).all<CL>();
    return result.results;
  },

  async updateCL(env: Env, id: string, patch: Partial<CL>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => k !== "id");
    if (keys.length === 0) return;
    const sets = `${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now')`;
    const values = keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null);
    await env.DB.prepare(`UPDATE cls SET ${sets} WHERE id = ?`)
      .bind(...values, id)
      .run();
  },

  async abandonCL(env: Env, id: string): Promise<void> {
    await env.DB.prepare(
      `UPDATE cls SET status = 'ABANDONED', updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(id)
      .run();
  },

  async getCoaching(env: Env, sha: string): Promise<string | null> {
    const r = await env.DB.prepare(`SELECT content FROM coaching WHERE sha = ?`)
      .bind(sha)
      .first<{ content: string }>();
    return r?.content ?? null;
  },

  async putCoaching(env: Env, sha: string, repo: string, content: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO coaching (sha, repo, content, generated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(sha) DO UPDATE SET content = excluded.content, generated_at = datetime('now')`,
    )
      .bind(sha, repo, content)
      .run();
  },

  async stats(env: Env): Promise<{
    live: number;
    open: number;
    devs: number;
    avg_deploy_ms: number | null;
  }> {
    const r = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN status = 'LIVE' THEN 1 ELSE 0 END) AS live,
        SUM(CASE WHEN status NOT IN ('LIVE', 'ABANDONED') THEN 1 ELSE 0 END) AS open,
        COUNT(DISTINCT author) AS devs,
        AVG(CASE WHEN status = 'LIVE' THEN deploy_ms END) AS avg_deploy_ms
      FROM cls
    `).first<{ live: number; open: number; devs: number; avg_deploy_ms: number | null }>();
    return r ?? { live: 0, open: 0, devs: 0, avg_deploy_ms: null };
  },
};
