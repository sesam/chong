import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "./config";
import type { CL, User } from "./types";

if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");

export const dao = {
  nextCLId(): string {
    const row = db
      .query<{ value: number }, []>(
        `INSERT INTO counters (name, value) VALUES ('cl', 1)
         ON CONFLICT(name) DO UPDATE SET value = counters.value + 1
         RETURNING value`,
      )
      .get();
    if (!row) throw new Error("failed to allocate CL id");
    return `CL-${String(row.value).padStart(3, "0")}`;
  },

  insertCL(
    cl: Pick<CL, "id" | "title" | "repo" | "branch" | "author"> & { status: CL["status"] },
  ): void {
    db.query(
      `INSERT INTO cls (id, title, repo, branch, author, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(cl.id, cl.title, cl.repo, cl.branch, cl.author, cl.status);
  },

  getCL(id: string): CL | null {
    return db.query<CL, [string]>(`SELECT * FROM cls WHERE id = ?`).get(id) ?? null;
  },

  getCLBySha(sha: string): CL | null {
    return db.query<CL, [string]>(`SELECT * FROM cls WHERE sha = ?`).get(sha) ?? null;
  },

  listCLs(q: { author?: string; status?: string; repo?: string }): CL[] {
    const where: string[] = [];
    const args: string[] = [];
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
    const sql = `SELECT * FROM cls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 200`;
    return db.query<CL, string[]>(sql).all(...args);
  },

  updateCL(id: string, patch: Partial<CL>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id");
    if (keys.length === 0) return;
    const sets = `${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now')`;
    const values = keys.map(
      (k) => (patch as Record<string, unknown>)[k] as string | number | null,
    );
    db.query(`UPDATE cls SET ${sets} WHERE id = ?`).run(...values, id);
  },

  abandonCL(id: string): void {
    db.query(
      `UPDATE cls SET status = 'ABANDONED', updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
  },

  getUserByToken(token: string): User | null {
    return (
      db
        .query<User, [string]>(`SELECT token, name, email FROM users WHERE token = ?`)
        .get(token) ?? null
    );
  },

  insertUser(token: string, name: string, email: string | null): void {
    db.query(`INSERT INTO users (token, name, email) VALUES (?, ?, ?)`).run(
      token,
      name,
      email,
    );
  },

  getCoaching(sha: string): string | null {
    const row = db
      .query<{ content: string }, [string]>(`SELECT content FROM coaching WHERE sha = ?`)
      .get(sha);
    return row?.content ?? null;
  },

  putCoaching(sha: string, repo: string, content: string): void {
    db.query(
      `INSERT INTO coaching (sha, repo, content, generated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(sha) DO UPDATE SET content = excluded.content, generated_at = datetime('now')`,
    ).run(sha, repo, content);
  },
};
