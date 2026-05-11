import { dao } from "./db";
import type { AuthCtx } from "./types";

export function authenticate(req: Request): AuthCtx | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const user = dao.getUserByToken(token);
  if (!user) return null;
  return { user: user.email ?? user.name };
}
