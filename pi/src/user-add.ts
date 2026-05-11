#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { dao } from "./db";

const [, , name, email] = process.argv;
if (!name) {
  console.error("usage: bun src/user-add.ts <name> [email]");
  process.exit(1);
}

const token = `chong_${randomBytes(24).toString("base64url")}`;
dao.insertUser(token, name, email ?? null);

console.log(`✓ added ${name}${email ? ` <${email}>` : ""}`);
console.log("");
console.log("Hand this token to the developer; they'll paste it into `chong auth login`:");
console.log("");
console.log(`  ${token}`);
console.log("");
console.log("(Treat it like a password — don't commit, don't paste in shared chat.)");
