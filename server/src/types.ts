export type Env = {
  DB: D1Database;
  HARNESS_URL: string;
  HARNESS_BOT_PAT: string;
  ANTHROPIC_API_KEY: string;
};

export type AuthCtx = {
  user: string;
  pat: string;
};

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
  sha: string | null;
  worker_url: string | null;
  deploy_id: string | null;
  lint_fixes: number;
  build_ms: number | null;
  deploy_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type HonoEnv = {
  Bindings: Env;
  Variables: { auth: AuthCtx };
};
