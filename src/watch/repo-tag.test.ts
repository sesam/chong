import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { repo } from "./repo";

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  return new TextDecoder().decode(r.stdout).trim();
}

test("moveTagForce moves a tag from a worktree and force-pushes it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chong-tag-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const shadow = path.join(root, "shadow");
  sh(root, "init", "--bare", origin);
  sh(root, "init", "-b", "main", work);
  sh(work, "config", "user.email", "t@t");
  sh(work, "config", "user.name", "t");
  sh(work, "remote", "add", "origin", origin);
  sh(work, "commit", "--allow-empty", "-m", "one");
  const one = sh(work, "rev-parse", "HEAD");
  sh(work, "commit", "--allow-empty", "-m", "two");
  const two = sh(work, "rev-parse", "HEAD");
  sh(work, "worktree", "add", "--detach", shadow, two);

  expect(await repo.moveTagForce(shadow, "origin", "current-stage", one, "m")).toBeNull();
  expect(await repo.moveTagForce(shadow, "origin", "current-stage", two, "m")).toBeNull();
  expect(sh(work, "rev-parse", "current-stage^{commit}")).toBe(two);
  expect(sh(origin, "rev-parse", "current-stage^{commit}")).toBe(two);
});

test("moveTagForce reports failure instead of throwing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chong-tag-"));
  sh(root, "init", "-b", "main", root);
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  sh(root, "commit", "--allow-empty", "-m", "one");
  const sha = sh(root, "rev-parse", "HEAD");
  const err = await repo.moveTagForce(root, "nope", "current-stage", sha, "m");
  expect(err).toBeTruthy();
});
