import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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

export async function writeAuth(a: Auth): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, JSON.stringify(a, null, 2));
}
