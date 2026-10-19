// Compile the chong binary with a build stamp. Replaces the old one-liner so the same script
// works on macOS (ad-hoc codesign, required or the kernel kills the binary) and Windows/Linux.
const sh = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

const commit = sh(["git", "rev-parse", "--short", "HEAD"]);
const dirty = sh(["git", "status", "--porcelain", "--", "src"]).out.length > 0;
const stampCommit = `${commit.ok ? commit.out : "unknown"}${dirty ? "+dirty" : ""}`;
const stampTime = new Date().toISOString();

const build = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    "--target=bun",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--define",
    `CHONG_BUILD_TIME=${JSON.stringify(stampTime)}`,
    "--define",
    `CHONG_BUILD_COMMIT=${JSON.stringify(stampCommit)}`,
    "./src/index.ts",
    "--outfile",
    "chong",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

if (process.platform === "darwin") {
  const sign = sh(["codesign", "--force", "--sign", "-", "./chong"]);
  if (!sign.ok) {
    console.error(`codesign failed: ${sign.err}`);
    process.exit(1);
  }
}
console.log(`built chong ${stampCommit} ${stampTime}`);
