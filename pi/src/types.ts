export type CLStatus =
  | "DRAFT"
  | "BUILDING"
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
  created_at: string;
  updated_at: string;
};

export type User = {
  token: string;
  name: string;
  email: string | null;
};

export type AuthCtx = {
  user: string;
};
