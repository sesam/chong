import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncHeadBranch } from "./local-rebase";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(cwd: string, file: string, content: string, msg = `edit ${file}`): string {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
}

/** A bare origin plus two clones: `me` (the watched workdir) and `other` (a teammate). */
function setup(): { me: string; other: string } {
  const root = mkdtempSync(path.join(tmpdir(), "chong-rebase-"));
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const me = path.join(root, "me");
  git(root, "clone", "-q", origin, me);
  git(me, "checkout", "-q", "-b", "main");
  commit(me, "a.txt", "one\ntwo\nthree\n");
  commit(me, "b.txt", "b\n");
  git(me, "push", "-q", "origin", "main");
  const other = path.join(root, "other");
  git(root, "clone", "-q", origin, other);
  return { me, other };
}

/** Teammate lands a commit on origin; `me` fetches it. Returns the new origin tip. */
function landOnOrigin(r: { me: string; other: string }, file: string, content: string): string {
  const sha = commit(r.other, file, content);
  git(r.other, "push", "-q", "origin", "main");
  git(r.me, "fetch", "-q", "origin");
  return sha;
}

const head = (cwd: string) => git(cwd, "rev-parse", "HEAD");
const read = (cwd: string, f: string) => readFileSync(path.join(cwd, f), "utf8");
const status = (cwd: string) => git(cwd, "status", "--porcelain");

describe("syncHeadBranch", () => {
  test("in sync / only ahead → leaves everything alone", async () => {
    const r = setup();
    expect(await syncHeadBranch(r.me, "origin", "main")).toBeNull();
    const mine = commit(r.me, "c.txt", "c\n");
    expect(await syncHeadBranch(r.me, "origin", "main")).toBeNull();
    expect(head(r.me)).toBe(mine);
  });

  test("behind → fast-forwards branch and working tree, keeping unrelated dirty work", async () => {
    const r = setup();
    writeFileSync(path.join(r.me, "b.txt"), "dirty\n"); // uncommitted edit
    writeFileSync(path.join(r.me, "scratch.txt"), "untracked\n");
    const tip = landOnOrigin(r, "a.txt", "one\ntwo\nthree\nfour\n");

    const res = await syncHeadBranch(r.me, "origin", "main");
    expect(res).toMatchObject({ ok: true, behind: 1 });
    expect(res?.rewritten).toBeUndefined();
    expect(head(r.me)).toBe(tip);
    expect(read(r.me, "a.txt")).toBe("one\ntwo\nthree\nfour\n");
    expect(read(r.me, "b.txt")).toBe("dirty\n");
    expect(status(r.me)).toBe(" M b.txt\n?? scratch.txt".trim());
  });

  test("behind, but a dirty file overlaps the incoming change → nothing moves", async () => {
    const r = setup();
    const before = head(r.me);
    writeFileSync(path.join(r.me, "a.txt"), "my edit\n");
    landOnOrigin(r, "a.txt", "theirs\n");

    const res = await syncHeadBranch(r.me, "origin", "main");
    expect(res).toMatchObject({ ok: false, blocked: true });
    expect(head(r.me)).toBe(before);
    expect(read(r.me, "a.txt")).toBe("my edit\n");
  });

  test("an untracked file in the way of an incoming file blocks the sync", async () => {
    const r = setup();
    const before = head(r.me);
    writeFileSync(path.join(r.me, "new.txt"), "mine\n");
    landOnOrigin(r, "new.txt", "theirs\n");

    expect(await syncHeadBranch(r.me, "origin", "main")).toMatchObject({ blocked: true });
    expect(head(r.me)).toBe(before);
    expect(read(r.me, "new.txt")).toBe("mine\n");
  });

  test("diverged → rebases local commits onto origin", async () => {
    const r = setup();
    const mine = commit(r.me, "c.txt", "c\n", "my local commit");
    const date = git(r.me, "log", "-1", "--format=%ad|%cd", "--date=raw");
    writeFileSync(path.join(r.me, "b.txt"), "dirty\n");
    const tip = landOnOrigin(r, "a.txt", "one\ntwo\nthree\nfour\n");

    const res = await syncHeadBranch(r.me, "origin", "main");
    expect(res).toMatchObject({ ok: true, behind: 1 });
    expect(res?.rewritten).toEqual([[mine, head(r.me)]]);
    expect(git(r.me, "rev-parse", "HEAD^")).toBe(tip);
    expect(git(r.me, "log", "-1", "--format=%s")).toBe("my local commit");
    expect(git(r.me, "log", "-1", "--format=%ad|%cd", "--date=raw")).toBe(date);
    expect(read(r.me, "a.txt")).toBe("one\ntwo\nthree\nfour\n");
    expect(read(r.me, "c.txt")).toBe("c\n");
    expect(status(r.me)).toBe("M b.txt"); // dirty edit survived, nothing else changed
    // Now a plain fast-forward for origin, and a second pass is a no-op.
    expect(await syncHeadBranch(r.me, "origin", "main")).toBeNull();
  });

  test("diverged with a conflict → branch, index and tree untouched", async () => {
    const r = setup();
    const mine = commit(r.me, "a.txt", "mine\n");
    landOnOrigin(r, "a.txt", "theirs\n");

    const res = await syncHeadBranch(r.me, "origin", "main");
    expect(res).toMatchObject({ ok: false, blocked: true });
    expect(res?.reason).toContain("conflicts with origin");
    expect(head(r.me)).toBe(mine);
    expect(status(r.me)).toBe("");
    expect(existsSync(path.join(r.me, ".git", "rebase-merge"))).toBe(false);
  });

  test("local commit already on origin under another sha → dropped, lands on origin tip", async () => {
    const r = setup();
    const mine = commit(r.me, "c.txt", "c\n", "shared work");
    landOnOrigin(r, "a.txt", "one\ntwo\nthree\nfour\n");
    // Teammate's clone picks up my commit by cherry-pick (what chong's inject does).
    git(r.other, "fetch", "-q", r.me, "main");
    git(r.other, "cherry-pick", mine);
    git(r.other, "push", "-q", "origin", "main");
    git(r.me, "fetch", "-q", "origin");

    const res = await syncHeadBranch(r.me, "origin", "main");
    expect(res).toMatchObject({ ok: true, rewritten: [] });
    expect(head(r.me)).toBe(git(r.me, "rev-parse", "origin/main"));
    expect(status(r.me)).toBe("");
  });

  test("local merge commit or an operation in progress → hands off", async () => {
    const r = setup();
    const before = head(r.me);
    landOnOrigin(r, "a.txt", "theirs\n");
    writeFileSync(path.join(r.me, ".git", "MERGE_HEAD"), `${before}\n`);
    expect(await syncHeadBranch(r.me, "origin", "main")).toBeNull();
    expect(head(r.me)).toBe(before);
  });

  test("branch not checked out anywhere → ref moves, current tree untouched", async () => {
    const r = setup();
    git(r.me, "checkout", "-q", "-b", "feature");
    const tip = landOnOrigin(r, "a.txt", "theirs\n");
    expect(await syncHeadBranch(r.me, "origin", "main")).toMatchObject({ ok: true });
    expect(git(r.me, "rev-parse", "main")).toBe(tip);
    expect(read(r.me, "a.txt")).toBe("one\ntwo\nthree\n");
  });
});
