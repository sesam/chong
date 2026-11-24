import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDeployClaim } from "./deploy-claim";
import {
  parseIniSection,
  resetS3Cache,
  resolveStaticAwsCreds,
  s3DeleteObject,
  s3ReadText,
  s3WriteText,
  setS3ClientFactoryForTest,
} from "./s3";

const dirs: string[] = [];

afterEach(() => {
  setS3ClientFactoryForTest(null);
  resetS3Cache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("S3 static credential resolution", () => {
  test("parses INI profile sections and resolves static credentials + region", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-aws-"));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, "credentials"),
      "[default]\naws_access_key_id = AKIA_DEF\naws_secret_access_key = SEC_DEF\n\n[deploy]\naws_access_key_id = AKIA_DEP\naws_secret_access_key = SEC_DEP\n",
    );
    writeFileSync(
      path.join(dir, "config"),
      "[default]\nregion = us-east-1\n\n[profile deploy]\nregion = eu-central-1\n",
    );

    const creds = resolveStaticAwsCreds({ AWS_PROFILE: "deploy" }, dir);
    expect(creds).toEqual({
      accessKeyId: "AKIA_DEP",
      secretAccessKey: "SEC_DEP",
      region: "eu-central-1",
    });
  });

  test("returns null for SSO / role_arn profiles so aws CLI handles dynamic refresh", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chong-aws-sso-"));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, "config"),
      "[profile sso-dev]\nsso_start_url = https://example.awsapps.com/start\nregion = eu-central-1\n",
    );
    expect(resolveStaticAwsCreds({ AWS_PROFILE: "sso-dev" }, dir)).toBeNull();
  });

  test("parseIniSection ignores comments and extracts only matching sections", () => {
    const parsed = parseIniSection(
      "# comment\n[profile a]\nregion = eu-west-1\n[profile b]\nregion = us-west-2\n",
      ["profile b"],
    );
    expect(parsed).toEqual({ region: "us-west-2" });
  });
});

describe("Native Bun.s3 transport", () => {
  test("reads, writes, deletes, and maps NoSuchKey to null without shelling out", async () => {
    const store = new Map<string, string>();
    setS3ClientFactoryForTest((bucket) => ({
      file: (key) => ({
        text: async () => {
          const val = store.get(`${bucket}/${key}`);
          if (val === undefined) {
            const e = new Error("NoSuchKey") as Error & { code?: string };
            e.code = "NoSuchKey";
            throw e;
          }
          return val;
        },
      }),
      write: async (key, data) => {
        store.set(`${bucket}/${key}`, data);
        return data.length;
      },
      delete: async (key) => {
        store.delete(`${bucket}/${key}`);
      },
    }));

    expect(await s3ReadText("my-bucket", "missing.txt")).toBeNull();
    expect(await s3WriteText("my-bucket", "deployed-git-sha.txt", "abcdef1234567")).toBeNull();
    expect(await s3ReadText("my-bucket", "deployed-git-sha.txt")).toBe("abcdef1234567\n");
    expect(await s3DeleteObject("my-bucket", "deployed-git-sha.txt")).toBeNull();
    expect(await s3ReadText("my-bucket", "deployed-git-sha.txt")).toBeNull();
  });

  test("parseDeployClaim accepts 64-char SHA-256 commit hashes (akk / git sha256)", () => {
    const sha64 = "a".repeat(64);
    const claim = parseDeployClaim(
      JSON.stringify({
        v: 1,
        id: "proc-1",
        user: "simon",
        sha: sha64,
        at: "2026-11-24T10:00:00.000Z",
      }),
    );
    expect(claim?.sha).toBe(sha64);
  });
});
