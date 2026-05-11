import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DATA_DIR = join(homedir(), ".chong-pi");

export const config = {
  dataDir: process.env.CHONG_DATA_DIR ?? DEFAULT_DATA_DIR,
  port: Number(process.env.PORT ?? 8787),
  bind: process.env.BIND ?? "127.0.0.1",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
};

export const reposDir = join(config.dataDir, "repos");
export const workDir = join(config.dataDir, "work");
export const dbPath = join(config.dataDir, "chong.db");
