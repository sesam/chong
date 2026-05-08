import { encRepo } from "./util";

export type HarnessCommit = {
  sha: string;
  message?: string;
  title?: string;
  author?: { identity?: { name?: string; email?: string }; when?: string };
  committer?: { identity?: { name?: string; email?: string }; when?: string };
};

export type HarnessPR = { number: number; state: string };

export type MergeResult = { sha: string };

export class Harness {
  constructor(
    private base: string,
    private token: string,
  ) {}

  private url(path: string): string {
    return `${this.base.replace(/\/+$/, "")}${path}`;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(this.url(path), {
      ...init,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`harness ${init.method ?? "GET"} ${path} → ${r.status} ${text.slice(0, 400)}`);
    }
    return (await r.json()) as T;
  }

  async createPR(
    repoRef: string,
    opts: { title: string; description?: string; source_branch: string; target_branch: string },
  ): Promise<HarnessPR> {
    return this.req<HarnessPR>(`/api/v1/repos/${encRepo(repoRef)}/pullreq`, {
      method: "POST",
      body: JSON.stringify({
        title: opts.title,
        description: opts.description ?? "",
        source_branch: opts.source_branch,
        target_branch: opts.target_branch,
        is_draft: false,
      }),
    });
  }

  async mergePR(repoRef: string, prNumber: number): Promise<MergeResult> {
    return this.req<MergeResult>(
      `/api/v1/repos/${encRepo(repoRef)}/pullreq/${prNumber}/merge`,
      {
        method: "POST",
        body: JSON.stringify({
          method: "squash",
          source_branch_delete: true,
          bypass_rules: true,
          dry_run: false,
        }),
      },
    );
  }

  async listCommits(
    repoRef: string,
    opts: { branch?: string; limit?: number; author?: string } = {},
  ): Promise<HarnessCommit[]> {
    const qs = new URLSearchParams();
    if (opts.branch) qs.set("git_ref", opts.branch);
    if (opts.limit) qs.set("limit", String(opts.limit));
    const r = await this.req<{ commits?: HarnessCommit[] }>(
      `/api/v1/repos/${encRepo(repoRef)}/commits?${qs.toString()}`,
    );
    let list = r.commits ?? [];
    if (opts.author) {
      const needle = opts.author.toLowerCase();
      list = list.filter((c) =>
        (c.author?.identity?.email ?? c.author?.identity?.name ?? "")
          .toLowerCase()
          .includes(needle),
      );
    }
    return list;
  }

  async getCommit(repoRef: string, sha: string): Promise<HarnessCommit> {
    return this.req<HarnessCommit>(`/api/v1/repos/${encRepo(repoRef)}/commits/${sha}`);
  }

  async getDiff(repoRef: string, sha: string): Promise<string> {
    const r = await fetch(this.url(`/api/v1/repos/${encRepo(repoRef)}/diff/${sha}`), {
      headers: { authorization: `Bearer ${this.token}`, accept: "text/plain" },
    });
    if (!r.ok) throw new Error(`harness diff ${sha} → ${r.status}`);
    return r.text();
  }
}
