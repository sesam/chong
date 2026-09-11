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
  unexpectedUntracked,
} from "./checks";
import { type WorktreeClaim, worktreeOwnerPath } from "./worktree-claim";

const FOREIGN_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const OURS = "11111111-1111-1111-1111-111111111111";

async function run(cmd: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${err || out}`);
  return out.trim();
}

const git = (args: string[], cwd: string, env?: Record<string, string>) =>
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
    env,
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

describe("shadowPathFor roles isolate deploy trees", () => {
  test("main / stage-deploy / prod-deploy resolve to distinct paths", () => {
    const repo = "/tmp/example/FRONTEND";
    const main = shadowPathFor(repo);
    const stage = shadowPathFor(repo, "stage-deploy");
    const prod = shadowPathFor(repo, "prod-deploy");
    expect(main).toContain("main-shadow");
    expect(stage).toContain("stage-deploy-shadow");
    expect(prod).toContain("prod-deploy-shadow");
    expect(new Set([main, stage, prod]).size).toBe(3);
  });

  test("default role stays main-shadow for existing callers", () => {
    const repo = "/tmp/example/FRONTEND";
    expect(shadowPathFor(repo)).toBe(shadowPathFor(repo, "main"));
  });
});

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
    // Backdated well past INJECT_GRACE_MS: a commit made *just now* by this test would
    // otherwise be held back by the grace window before reconcileLocalMain ever reaches
    // the diverged/foreign-claim path this test is about.
    await git(["commit", "-qm", "ours"], work, {
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
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

describe("reconcileLocalMain grace window", () => {
  /** A bare remote + one clone, already in sync on `base`. */
  async function setupLinearRepo(): Promise<string> {
    const root = mkdtempSync(path.join(tmpdir(), "chong-grace-"));
    const bare = path.join(root, "remote.git");
    const work = path.join(root, "work");
    await git(["init", "-q", "--bare", "-b", "main", bare], root);
    await git(["clone", "-q", bare, work], root);
    writeFileSync(path.join(work, "base.txt"), "base\n");
    await git(["add", "--", "base.txt"], work);
    await git(["commit", "-qm", "base"], work);
    await git(["push", "-q", "origin", "main"], work);
    await git(["fetch", "-q", "origin", "main"], work);
    return work;
  }

  test("holds back a brand-new local commit instead of pushing it immediately", async () => {
    const work = await setupLinearRepo();
    writeFileSync(path.join(work, "new.txt"), "new\n");
    await git(["add", "--", "new.txt"], work);
    await git(["commit", "-qm", "brand new"], work); // committed just now — inside the window

    const before = await git(["rev-parse", "origin/main"], work);
    const res = await reconcileLocalMain(work, "origin", "main", {
      processId: OURS,
      agentResolve: false,
    });

    expect(res.action).toBe("noop");
    expect(res.pushed).toBe(false);
    expect(res.message).toContain("grace window");
    expect(await git(["rev-parse", "origin/main"], work)).toBe(before);
  });

  test("pushes once the commit has cleared the grace window", async () => {
    const work = await setupLinearRepo();
    writeFileSync(path.join(work, "new.txt"), "new\n");
    await git(["add", "--", "new.txt"], work);
    await git(["commit", "-qm", "old enough"], work, {
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    const localTip = await git(["rev-parse", "main"], work);

    const res = await reconcileLocalMain(work, "origin", "main", {
      processId: OURS,
      agentResolve: false,
    });

    expect(res.action).toBe("pushed");
    expect(res.pushed).toBe(true);
    expect(await git(["rev-parse", "origin/main"], work)).toBe(localTip);
  });

  test("autoInject: false refuses to push regardless of commit age", async () => {
    const work = await setupLinearRepo();
    writeFileSync(path.join(work, "new.txt"), "new\n");
    await git(["add", "--", "new.txt"], work);
    await git(["commit", "-qm", "old enough"], work, {
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });

    const before = await git(["rev-parse", "origin/main"], work);
    const res = await reconcileLocalMain(work, "origin", "main", {
      processId: OURS,
      agentResolve: false,
      autoInject: false,
    });

    expect(res.action).toBe("noop");
    expect(res.pushed).toBe(false);
    expect(res.message).toContain("--no-auto-inject");
    expect(await git(["rev-parse", "origin/main"], work)).toBe(before);
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

describe("unexpectedUntracked — explicit-path staging refuses to sweep surprise files", () => {
  async function repoWithFiles(files: Record<string, string>): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-untracked-"));
    await git(["init", "-q", "-b", "main", "."], dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  test("empty when only the expected (allowlisted) paths are untracked", async () => {
    const dir = await repoWithFiles({ "feature.en.po": "x\n", "feature.sl.po": "y\n" });
    const unexpected = await unexpectedUntracked(dir, ["feature.en.po", "feature.sl.po"]);
    expect(unexpected).toEqual([]);
  });

  test("flags an untracked scratch file outside the allowlist", async () => {
    const dir = await repoWithFiles({
      "feature.en.po": "x\n",
      "agent-notes.md": "scratch\n", // e.g. left behind by an agent run
    });
    const unexpected = await unexpectedUntracked(dir, ["feature.en.po"]);
    expect(unexpected).toEqual(["agent-notes.md"]);
  });

  test("accepts a predicate instead of an explicit allowlist (i18n's .po/.pot rule)", async () => {
    const dir = await repoWithFiles({ "new-feature.en.po": "x\n", "stray.md": "scratch\n" });
    const isExpected = (p: string) => p.endsWith(".po") || p.endsWith(".pot");
    expect(await unexpectedUntracked(dir, isExpected)).toEqual(["stray.md"]);
  });

  test("modified tracked files are not untracked, regardless of scope", async () => {
    const dir = await repoWithFiles({ "tracked.txt": "a\n" });
    await git(["add", "--", "tracked.txt"], dir);
    await git(["commit", "-qm", "base"], dir);
    writeFileSync(path.join(dir, "tracked.txt"), "b\n"); // modified, still tracked
    expect(await unexpectedUntracked(dir, [])).toEqual([]);
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
