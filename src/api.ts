import { readAuth } from "./config";

export type CLStatus =
  | "DRAFT"
  | "BUILDING"
  | "LINT_ERROR"
  | "BUILD_ERROR"
  | "LIVE"
  | "ABANDONED";

export type CL = {
  id: string;
  title: string;
  repo: string;
  branch: string;
  author: string;
  status: CLStatus;
  sha?: string;
  worker_url?: string;
  created_at: string;
  updated_at?: string;
};

export type Commit = {
  sha: string;
  repo: string;
  author: string;
  message: string;
  cl_id?: string;
  date: string;
};

export type CommitDetail = {
  commit: Commit;
  diff: string;
  coaching?: unknown;
};

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = await readAuth();
  const r = await fetch(auth.server.replace(/\/+$/, "") + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} → ${r.status} ${text.slice(0, 400)}`);
  }
  return (await r.json()) as T;
}

function qs(params: Record<string, string | undefined>): string {
  const filtered = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (filtered.length === 0) return "";
  return `?${new URLSearchParams(filtered as [string, string][]).toString()}`;
}

export const api = {
  createCL: (b: { title: string; repo: string }) =>
    req<CL>("/api/cls", { method: "POST", body: JSON.stringify(b) }),

  getCL: (id: string) => req<CL>(`/api/cls/${encodeURIComponent(id)}`),

  listCLs: (q: { author?: string; status?: string } = {}) =>
    req<CL[]>(`/api/cls${qs(q)}`),

  abandonCL: (id: string) =>
    req<{ ok: true }>(`/api/cls/${encodeURIComponent(id)}`, { method: "DELETE" }),

  history: (q: { repo?: string; author?: string } = {}) =>
    req<Commit[]>(`/api/history${qs(q)}`),

  commit: (sha: string, repo: string) =>
    req<CommitDetail>(`/api/commit/${encodeURIComponent(sha)}${qs({ repo })}`),
};

export type SSEvent = { event: string; data: string };

export async function* uploadStream(id: string, sha: string): AsyncGenerator<SSEvent> {
  const auth = await readAuth();
  const r = await fetch(
    `${auth.server.replace(/\/+$/, "")}/api/cls/${encodeURIComponent(id)}/upload`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.token}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify({ sha }),
    },
  );
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => "");
    throw new Error(`upload start failed: ${r.status} ${text.slice(0, 400)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const ln of block.split("\n")) {
        if (ln.startsWith("event:")) event = ln.slice(6).trim();
        else if (ln.startsWith("data:")) data += (data ? "\n" : "") + ln.slice(5).trim();
      }
      yield { event, data };
      idx = buf.indexOf("\n\n");
    }
  }
}
