import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Auth = {
  server: string;
  token: string;
  user: string;
};

const dir = join(homedir(), ".chong");
const file = join(dir, "auth.json");

export async function readAuth(): Promise<Auth> {
  if (!existsSync(file)) {
    throw new Error("not authenticated — run `chong auth login`");
  }
  return JSON.parse(await Bun.file(file).text()) as Auth;
}

/**
 * Persist the Harness PAT. `Bun.write` (like a plain `fs.writeFile`) creates the file with
 * mode 0666 minus umask — commonly 0644, i.e. world-readable — so any other local account
 * could read this credential off disk. `mkdir`+`chmod` on the containing directory (0700)
 * and the file itself (0600) close that, including for a directory/file that already
 * existed with looser permissions from before this fix (chmod always applies, not just on
 * create). Best-effort: a chmod failure (e.g. an unusual filesystem) is reported, not
 * fatal — the token is still written and usable, just not as tightly locked down.
 */
export async function writeAuth(a: Auth): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    await chmod(dir, 0o700);
  } catch (e) {
    console.error(`chong: could not chmod ${dir} to 0700 (${e instanceof Error ? e.message : e})`);
  }
  await Bun.write(file, JSON.stringify(a, null, 2));
  try {
    await chmod(file, 0o600);
  } catch (e) {
    console.error(`chong: could not chmod ${file} to 0600 (${e instanceof Error ? e.message : e})`);
  }
}
