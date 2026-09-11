import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringWidth } from "./render";
import { SEP, parseCommit, sanitizeCommitText } from "./repo";

describe("sanitizeCommitText", () => {
  test("strips the ESC/BEL bytes that make CSI/SGR/OSC sequences dangerous", () => {
    // The allowlist drops the ESC (\x1b) and BEL (\x07) control bytes themselves — the
    // bytes a terminal needs to *start interpreting* an escape sequence. What's left
    // ("[31m", "]0;HIJACK") is inert, visible text; no escape sequence survives.
    const raw = "boom \x1b[31mRED\x1b[0m \x1b]0;HIJACK\x07 fix";
    const clean = sanitizeCommitText(raw, 300);
    expect(clean).not.toContain("\x1b");
    expect(clean).not.toContain("\x07");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
    expect(clean).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  test("strips bare C0/C1 control characters", () => {
    const raw = "line1\r\nline2\x00\x0btail\x9bhi";
    const clean = sanitizeCommitText(raw, 300);
    for (const ch of clean) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)).toBe(false);
    }
  });

  test("strips zero-width and bidi-override characters (format category)", () => {
    // ZWJ, ZWSP, RLO, PDF
    const raw = "a‍z​h‮‬";
    const clean = sanitizeCommitText(raw, 300);
    expect(clean).toBe("azh");
  });

  test("preserves accented Latin, normal punctuation, and NFC-composes decomposed accents", () => {
    // "é" as e + combining acute (NFD) should compose to a single codepoint and survive.
    const decomposed = "café, naïve — it's fine (really!) 100%";
    const clean = sanitizeCommitText(decomposed, 300);
    expect(clean).toContain("café");
    expect(clean).toContain("naïve");
    expect(clean).toContain("it's fine (really!) 100%");
  });

  test("caps length after sanitizing", () => {
    const clean = sanitizeCommitText("x".repeat(500), 10);
    expect(clean.length).toBe(10);
  });
});

describe("parseCommit", () => {
  test("sanitizes author and subject fields at the parse boundary", () => {
    const sha = "a".repeat(40);
    const line = `${[
      sha,
      "Mal\x1b[31micious\x07 Author",
      "2 days ago",
      "2026-09-01T00:00:00+00:00",
    ].join(SEP)}${SEP}boom \x1b[31mRED\x1b[0m \x1b]0;HIJACK\x07 fix`;
    const commit = parseCommit(line);
    expect(commit).not.toBeNull();
    expect(commit?.author).not.toContain("\x1b");
    expect(commit?.author).not.toContain("\x07");
    expect(commit?.subject).not.toContain("\x1b");
    expect(commit?.subject).not.toContain("\x07");
    expect(commit?.short).toBe(sha.slice(0, 7));
  });

  test("returns null for a line with no sha field", () => {
    expect(parseCommit("")).toBeNull();
  });
});

describe("stringWidth", () => {
  test("plain ASCII width equals length", () => {
    expect(stringWidth("hello world")).toBe(11);
  });

  test("CJK characters count as width 2 each", () => {
    expect(stringWidth("你好")).toBe(4);
  });

  test("combining marks don't add extra width to their base grapheme", () => {
    const decomposed = "é"; // "é" as base + combining acute -> one grapheme cluster
    expect(stringWidth(decomposed)).toBe(1);
  });

  test("zero-width joiner emoji sequence counts as one grapheme's width", () => {
    // family emoji built from ZWJ-joined parts should not blow up the visual width
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(stringWidth(family)).toBeLessThanOrEqual(2);
  });
});

describe("quoted-path parsing via git apply --numstat -z", () => {
  test("paths with spaces or non-ASCII bytes are not shell-quoted when using -z", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-repo-fixture-"));
    const git = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      return { ok: code === 0, out: out.trim(), err: err.trim() };
    };

    await git(["init", "-q"]);
    await git(["config", "user.email", "a@a.com"]);
    await git(["config", "user.name", "a"]);
    await Bun.write(path.join(dir, "a b.txt"), "x");
    await Bun.write(path.join(dir, "č.txt"), "x");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "init"]);
    await Bun.write(path.join(dir, "a b.txt"), "y");
    await Bun.write(path.join(dir, "č.txt"), "y");

    const diff = await git(["diff"]);
    const patchFile = path.join(dir, "patch.diff");
    await Bun.write(patchFile, `${diff.out}\n`);

    const numstat = await git(["apply", "--numstat", "-z", "--", patchFile]);
    expect(numstat.ok).toBe(true);
    const paths = numstat.out
      .split("\0")
      .map((line) => line.split("\t").pop()?.trim() ?? "")
      .filter(Boolean);
    expect(paths).toContain("a b.txt");
    expect(paths).toContain("č.txt");
    // Neither path should come back wrapped in git's C-style quoting.
    for (const p of paths) {
      expect(p.startsWith('"')).toBe(false);
    }
  });
});
