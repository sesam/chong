import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { repo } from "./repo";

test("repo.tip is empty for a ref that does not resolve", async () => {
  // A plain `git rev-parse origin/x` echoes "origin/x" on stdout when it fails; callers
  // guard with `if (!tip)`, so the name used to flow on as though it were a sha.
  const dir = mkdtempSync(path.join(tmpdir(), "chong-tip-"));
  const run = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir });
  run("init", "-q", "-b", "main");
  run(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  );
  const head = run("rev-parse", "HEAD").stdout.toString().trim();
  run("update-ref", "refs/remotes/origin/main", head);

  expect(await repo.tip(dir, "origin", "main")).toBe(head);
  expect(await repo.tip(dir, "origin", "nope")).toBe("");
});
