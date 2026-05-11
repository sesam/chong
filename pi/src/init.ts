#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, dbPath, reposDir, workDir } from "./config";

for (const d of [config.dataDir, reposDir, workDir, dirname(dbPath)]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const schemaPath = join(import.meta.dir, "..", "schema.sql");
const db = new Database(dbPath);
db.exec(readFileSync(schemaPath, "utf8"));

console.log(`✓ data dir: ${config.dataDir}`);
console.log(`✓ db:       ${dbPath}`);
console.log(`✓ repos:    ${reposDir}`);
console.log(`✓ work:     ${workDir}`);
console.log("");
console.log("Add a developer:");
console.log("  bun src/user-add.ts <name> [email]");
