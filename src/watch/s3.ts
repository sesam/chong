import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
/**
 * Lightweight S3 object transport for chong's tiny markers (`deployed-git-sha.txt`,
 * `deployed-tree-sha.txt`) and soft deploy claims (`deploy-claim.json`).
 *
 * Uses Bun's native `S3Client` (`Bun.s3`) whenever static AWS credentials are available
 * (from env vars or `~/.aws/credentials` + `~/.aws/config` for the active deploy profile).
 * That eliminates 6× Python `aws` CLI cold-starts every 15-second poll (~300MB burst RAM
 * and 1.5–3s CPU per poll → ~15ms and ~0MB).
 *
 * Automatically falls back to the `aws` CLI (bounded by a hard timeout, with both pipes
 * drained and all spawn errors caught) when:
 *   - credentials come from SSO, `credential_process`, `role_arn`, or EC2 IMDS;
 *   - `CHONG_S3_TRANSPORT=aws` is set;
 *   - `Bun.spawn` is mocked by tests (`spyOn(Bun, "spawn")`);
 *   - a native S3 call fails with a non-404 error (e.g. region redirect or expired creds).
 */
import { S3Client } from "bun";
import { deployAwsEnv, getDeployAwsProfile } from "./runtime";

export const S3_OP_TIMEOUT_MS = 15_000;

export type StaticAwsCreds = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
  endpoint?: string;
};

/** Parse a minimal INI section from `~/.aws/credentials` or `~/.aws/config`. */
export function parseIniSection(text: string, sectionNames: string[]): Record<string, string> {
  const want = new Set(sectionNames);
  const out: Record<string, string> = {};
  let active = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      active = want.has(sec[1].trim());
      continue;
    }
    if (!active) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

type CredsCache = {
  key: string;
  credsMtime: number;
  configMtime: number;
  value: StaticAwsCreds | null;
};

let credsCache: CredsCache | null = null;

function safeMtime(p: string): number {
  try {
    return existsSync(p) ? statSync(p).mtimeMs : -1;
  } catch {
    return -1;
  }
}

/**
 * Resolve static AWS credentials from env or `~/.aws/{credentials,config}` for the active
 * deploy profile (`CHONG_DEPLOY_AWS_PROFILE` > `AWS_PROFILE` > `default`).
 * Returns null if dynamic credentials (SSO, role_arn, credential_process, IMDS) are in use.
 */
export function resolveStaticAwsCreds(
  env: Record<string, string> = deployAwsEnv(),
  awsDir = path.join(homedir(), ".aws"),
): StaticAwsCreds | null {
  const endpoint = env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL || undefined;
  const envRegion = env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined;
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      ...(envRegion ? { region: envRegion } : {}),
      ...(endpoint ? { endpoint } : {}),
    };
  }

  const profile = getDeployAwsProfile() || env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || "default";
  const credsFile = env.AWS_SHARED_CREDENTIALS_FILE || path.join(awsDir, "credentials");
  const configFile = env.AWS_CONFIG_FILE || path.join(awsDir, "config");
  const cacheKey = `${profile}|${credsFile}|${configFile}|${envRegion ?? ""}|${endpoint ?? ""}`;
  const credsMtime = safeMtime(credsFile);
  const configMtime = safeMtime(configFile);

  if (
    credsCache &&
    credsCache.key === cacheKey &&
    credsCache.credsMtime === credsMtime &&
    credsCache.configMtime === configMtime
  ) {
    return credsCache.value;
  }

  let value: StaticAwsCreds | null = null;
  try {
    const configSections = profile === "default" ? ["default"] : [`profile ${profile}`, profile];
    const cfg =
      configMtime >= 0 ? parseIniSection(readFileSync(configFile, "utf8"), configSections) : {};
    // Dynamic credential providers must go through the aws CLI.
    if (cfg.role_arn || cfg.credential_process || cfg.sso_start_url || cfg.sso_session) {
      value = null;
    } else {
      const cred =
        credsMtime >= 0 ? parseIniSection(readFileSync(credsFile, "utf8"), [profile]) : {};
      const accessKeyId = cred.aws_access_key_id || cfg.aws_access_key_id;
      const secretAccessKey = cred.aws_secret_access_key || cfg.aws_secret_access_key;
      const sessionToken = cred.aws_session_token || cfg.aws_session_token;
      const region = envRegion || cfg.region || cred.region;
      if (accessKeyId && secretAccessKey) {
        value = {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
          ...(region ? { region } : {}),
          ...(endpoint ? { endpoint } : {}),
        };
      }
    }
  } catch {
    value = null;
  }

  credsCache = { key: cacheKey, credsMtime, configMtime, value };
  return value;
}

/** Reset cached credentials/clients (for tests). */
export function resetS3Cache(): void {
  credsCache = null;
  clientPool.clear();
  nativeDisabledBuckets.clear();
}

export type S3ClientLike = {
  file(key: string): { text(): Promise<string> };
  write(key: string, data: string, options?: { type?: string }): Promise<number>;
  delete(key: string): Promise<void>;
};

let customClientFactory: ((bucket: string, creds: StaticAwsCreds) => S3ClientLike) | null = null;

/** Test hook to inject a fake S3Client without touching network or Bun.spawn. */
export function setS3ClientFactoryForTest(
  factory: ((bucket: string, creds: StaticAwsCreds) => S3ClientLike) | null,
): void {
  customClientFactory = factory;
  clientPool.clear();
  nativeDisabledBuckets.clear();
}

const clientPool = new Map<string, S3ClientLike>();
/** Buckets where native S3Client hit a structural error (e.g. region mismatch) → use aws CLI. */
const nativeDisabledBuckets = new Set<string>();

function isSpawnMocked(): boolean {
  return Boolean((Bun.spawn as unknown as { mock?: unknown }).mock);
}

function getNativeClient(bucket: string): S3ClientLike | null {
  if (process.env.CHONG_S3_TRANSPORT === "aws") return null;
  if (isSpawnMocked() && !customClientFactory) return null;
  if (nativeDisabledBuckets.has(bucket)) return null;

  const creds = customClientFactory
    ? (resolveStaticAwsCreds() ?? {
        accessKeyId: "test",
        secretAccessKey: "test",
        region: "us-east-1",
      })
    : resolveStaticAwsCreds();
  if (!creds) return null;

  const poolKey = `${bucket}|${creds.accessKeyId}|${creds.sessionToken ?? ""}|${creds.region ?? ""}|${creds.endpoint ?? ""}`;
  let client = clientPool.get(poolKey);
  if (!client) {
    if (clientPool.size > 32) clientPool.clear();
    client = customClientFactory
      ? customClientFactory(bucket, creds)
      : new S3Client({
          bucket,
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
          ...(creds.region ? { region: creds.region } : {}),
          ...(creds.endpoint ? { endpoint: creds.endpoint } : {}),
        });
    clientPool.set(poolKey, client);
  }
  return client;
}

function withOpTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_res, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isS3NotFoundError(err: unknown): boolean {
  const code = String((err as { code?: unknown })?.code ?? "");
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code === "NoSuchKey" ||
    code === "ENOENT" ||
    code === "ERR_S3_NOT_FOUND" ||
    /\b(NoSuchKey|404|Not\s*Found)\b/i.test(msg)
  );
}

function isS3StructuralRedirect(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /PermanentRedirect|AuthorizationHeaderMalformed|InvalidAccessKeyId|ExpiredToken|301/i.test(
    msg,
  );
}

// ── aws CLI fallback (bounded timeout + full pipe drain + try/catch) ─────────

async function awsReadText(
  bucket: string,
  key: string,
  timeoutMs = S3_OP_TIMEOUT_MS,
): Promise<string | null> {
  const uri = `s3://${bucket}/${key}`;
  try {
    const proc = Bun.spawn(["aws", "s3", "cp", uri, "-", "--quiet"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      env: deployAwsEnv(process.env, { AWS_PAGER: "" }),
    });
    const [out, _err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return null;
    return out;
  } catch {
    return null;
  }
}

async function awsWriteText(
  bucket: string,
  key: string,
  body: string,
  timeoutMs = S3_OP_TIMEOUT_MS,
): Promise<string | null> {
  const uri = `s3://${bucket}/${key}`;
  try {
    const proc = Bun.spawn(
      [
        "aws",
        "s3",
        "cp",
        "-",
        uri,
        "--cache-control",
        "no-store",
        "--content-type",
        key.endsWith(".json") ? "application/json" : "text/plain",
        "--quiet",
      ],
      {
        stdin: new Blob([body]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        env: deployAwsEnv(process.env, { AWS_PAGER: "" }),
      },
    );
    const [_out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (proc.signalCode !== null && proc.killed) {
      return `aws s3 cp timed out after ${Math.round(timeoutMs / 1000)}s`;
    }
    return code === 0 ? null : err.trim() || `aws s3 cp failed (${code})`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function awsDeleteObject(
  bucket: string,
  key: string,
  timeoutMs = S3_OP_TIMEOUT_MS,
): Promise<string | null> {
  const uri = `s3://${bucket}/${key}`;
  try {
    const proc = Bun.spawn(["aws", "s3", "rm", uri, "--quiet"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      env: deployAwsEnv(process.env, { AWS_PAGER: "" }),
    });
    const [_out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (proc.signalCode !== null && proc.killed) {
      return `aws s3 rm timed out after ${Math.round(timeoutMs / 1000)}s`;
    }
    return code === 0 ? null : err.trim() || `aws s3 rm failed (${code})`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ── Public S3 object helpers ─────────────────────────────────────────────────

export async function s3ReadText(
  bucket: string,
  key: string,
  timeoutMs = S3_OP_TIMEOUT_MS,
): Promise<string | null> {
  const client = getNativeClient(bucket);
  if (client) {
    try {
      return await withOpTimeout(client.file(key).text(), timeoutMs, `s3 get ${bucket}/${key}`);
    } catch (err) {
      if (isS3NotFoundError(err)) return null;
      if (isS3StructuralRedirect(err)) nativeDisabledBuckets.add(bucket);
      if (customClientFactory) return null;
      return awsReadText(bucket, key, timeoutMs);
    }
  }
  return awsReadText(bucket, key, timeoutMs);
}

export async function s3WriteText(
  bucket: string,
  key: string,
  value: string,
  timeoutMs = S3_OP_TIMEOUT_MS,
): Promise<string | null> {
  const body = value.endsWith("\n") || value === "" ? value : `${value}\n`;
  const client = getNativeClient(bucket);
  if (client) {
    try {
      await withOpTimeout(
        client.write(key, body, {
          type: key.endsWith(".json") ? "application/json" : "text/plain",
        }),
        timeoutMs,
        `s3 put ${bucket}/${key}`,
      );
      return null;
    } catch (err) {
      if (isS3StructuralRedirect(err)) nativeDisabledBuckets.add(bucket);
      if (customClientFactory) return err instanceof Error ? err.message : String(err);
      return awsWriteText(bucket, key, body, timeoutMs);
    }
  }
  return awsWriteText(bucket, key, body, timeoutMs);
}

export async function s3DeleteObject(
  bucket: string,
  key: string,
  timeoutMs = S3_OP_TIMEOUT_MS,
): Promise<string | null> {
  const client = getNativeClient(bucket);
  if (client) {
    try {
      await withOpTimeout(client.delete(key), timeoutMs, `s3 del ${bucket}/${key}`);
      return null;
    } catch (err) {
      if (isS3NotFoundError(err)) return null;
      if (isS3StructuralRedirect(err)) nativeDisabledBuckets.add(bucket);
      if (customClientFactory) return err instanceof Error ? err.message : String(err);
      return awsDeleteObject(bucket, key, timeoutMs);
    }
  }
  return awsDeleteObject(bucket, key, timeoutMs);
}
