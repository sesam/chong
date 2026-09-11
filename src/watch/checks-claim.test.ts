import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureShadow,
  parseStatusZ,
  reconcileLocalMain,
  shadowPathFor,
  splitNulPaths,
} from "./checks";
import { type WorktreeClaim, worktreeOwnerPath } from "./worktree-claim";

const FOREIGN_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const OURS = "11111111-1111-1111-1111-111111111111";

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${err || out}`);
  return out.trim();
}

const git = (args: string[], cwd: string) =>
  run(
    [
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    cwd,
  );

/** Paths created under ~/.chong by a test, removed afterwards. */
const litter: string[] = [];

afterEach(() => {
  for (const p of litter.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** Plant a live claim owned by somebody else beside the repo's shadow worktree. */
function plantForeignClaim(repoPath: string): string {
  const shadowPath = shadowPathFor(repoPath);
  const owner = worktreeOwnerPath(shadowPath);
  const claim: WorktreeClaim = {
    v: 1,
    id: FOREIGN_ID,
    user: "someone-else",
    at: new Date().toISOString(),
    host: "otherbox",
    pid: 4242,
  };
  litter.push(owner, shadowPath);
  writeFileSync(owner, `${JSON.stringify(claim)}\n`);
  return shadowPath;
}

describe("ensureShadow requires a claim", () => {
  test("the claim is a required argument, not an optional one", () => {
    // A type-level guarantee, asserted here so the intent is recorded next to the
    // runtime tests: `ensureShadow(repoPath, ref)` and `ensureShadow(repoPath, ref, {})`
    // are both compile errors, because `opts` is required and so is `opts.processId`.
    // There is no `unclaimed` escape hatch to accidentally reach for — every code path
    // in ensureShadow mutates the shared worktree. Runtime cannot express "this call
    // does not compile", so the checks below cover what runtime can see instead.
    // @ts-expect-error — opts is required
    const noOpts: unknown = () => ensureShadow("/tmp/nope", "origin/main");
    // @ts-expect-error — processId is required within opts
    const noId: unknown = () => ensureShadow("/tmp/nope", "origin/main", {});
    expect(typeof noOpts).toBe("function");
    expect(typeof noId).toBe("function");
  });

  test("refuses and names the holder when the claim is held by another process", async () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), "chong-claim-repo-"));
    plantForeignClaim(repoPath);

    const shadow = await ensureShadow(repoPath, "origin/main", { processId: OURS });

    expect(shadow.error).toContain("worktree claimed by someone-else@otherbox pid=4242");
    expect(shadow.claim.ok).toBe(false);
    // Bailed before any git ran: no worktree was created, so nothing was reset.
    expect(existsSync(shadow.shadowPath)).toBe(false);
  });

  test("surfaces the acquired claim so the caller's ownership view can follow it", async () => {
    // The bug: the acquire happened inside ensureShadow and was swallowed, so `chong
    // watch` told the operator "no worktree ownership" while this process held it.
    const repoPath = mkdtempSync(path.join(tmpdir(), "chong-claim-repo-"));
    await git(["init", "-q", "-b", "main", "."], repoPath);
    writeFileSync(path.join(repoPath, "a.txt"), "a\n");
    await git(["add", "--", "a.txt"], repoPath);
    await git(["commit", "-qm", "a"], repoPath);

    const shadowPath = shadowPathFor(repoPath);
    litter.push(shadowPath, worktreeOwnerPath(shadowPath));

    const shadow = await ensureShadow(repoPath, "HEAD", { processId: OURS });
    expect(shadow.error).toBeNull();
    expect(shadow.claim.ok).toBe(true);
    if (shadow.claim.ok) expect(shadow.claim.claim.id).toBe(OURS);
  });
});

describe("reconcileLocalMain under a foreign claim", () => {
  test("a non-owner's diverged reconcile is refused instead of resetting main-shadow", async () => {
    // Two clones of one remote, each with a commit the other lacks → the diverged
    // branch of reconcile, which is the branch that hard-resets the shared worktree.
    const root = mkdtempSync(path.join(tmpdir(), "chong-reconcile-"));
    const bare = path.join(root, "remote.git");
    const work = path.join(root, "work");
    const other = path.join(root, "other");

    await git(["init", "-q", "--bare", "-b", "main", bare], root);
    await git(["clone", "-q", bare, work], root);
    writeFileSync(path.join(work, "base.txt"), "base\n");
    await git(["add", "--", "base.txt"], work);
    await git(["commit", "-qm", "base"], work);
    await git(["push", "-q", "origin", "main"], work);

    await git(["clone", "-q", bare, other], root);
    writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
    await git(["add", "--", "theirs.txt"], other);
    await git(["commit", "-qm", "theirs"], other);
    await git(["push", "-q", "origin", "main"], other);

    writeFileSync(path.join(work, "ours.txt"), "ours\n");
    await git(["add", "--", "ours.txt"], work);
    await git(["commit", "-qm", "ours"], work);
    await git(["fetch", "-q", "origin", "main"], work);

    plantForeignClaim(work);

    const res = await reconcileLocalMain(work, "origin", "main", {
      processId: OURS,
      agentResolve: false,
    });

    expect(res.action).toBe("error");
    expect(res.message).toContain("worktree claimed by someone-else@otherbox pid=4242");
    // The refusal must land before anything is pushed on the foreign owner's behalf.
    expect(res.pushed).toBe(false);
    expect(existsSync(shadowPathFor(work))).toBe(false);
  });
});

describe("parseStatusZ — paths git would otherwise quote", () => {
  // Without -z these arrive as `"a b.txt"` / `"\304\215.txt"`, which then match no
  // diff-tree path and name no file for `git checkout --` / `git add --`: the file was
  // silently neither reverted nor staged, and a later `git add -A` swept it up.
  test("keeps spaces, quotes and non-ASCII verbatim", () => {
    const out = ' M a b.txt\0?? čšž.vue\0 M say "hi".ts\0';
    expect(parseStatusZ(out)).toEqual(["a b.txt", "čšž.vue", 'say "hi".ts']);
  });

  test("does not lose a leading space in a path", () => {
    expect(parseStatusZ(" M  leading.txt\0")).toEqual([" leading.txt"]);
  });

  test("consumes the source path of a rename instead of reading it as an entry", () => {
    // `R  new\0old\0` is one entry across two NUL-terminated fields.
    expect(parseStatusZ("R  new name.txt\0old name.txt\0 M other.txt\0")).toEqual([
      "new name.txt",
      "other.txt",
    ]);
  });

  test("empty status is no paths", () => {
    expect(parseStatusZ("")).toEqual([]);
    expect(parseStatusZ("\0")).toEqual([]);
  });

  test("matches what git actually emits for an awkward filename", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-quotepath-"));
    await git(["init", "-q", "-b", "main", "."], dir);
    const awkward = "a b čšž.txt";
    writeFileSync(path.join(dir, awkward), "x\n");
    const proc = Bun.spawn(["git", "status", "--porcelain", "-z"], { cwd: dir, stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(parseStatusZ(out)).toEqual([awkward]);
  });
});

describe("splitNulPaths", () => {
  test("splits NUL-separated output and drops the trailing empty field", () => {
    expect(splitNulPaths("a b.txt\0čšž.vue\0")).toEqual(["a b.txt", "čšž.vue"]);
  });

  test("no output is no paths", () => {
    expect(splitNulPaths("")).toEqual([]);
  });
});
