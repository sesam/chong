import { reposDir } from "../config";

const MAX_HEADER_BYTES = 64 * 1024;

function findHeaderEnd(buf: Uint8Array): { split: number; bodyOffset: number } | null {
  for (let i = 0; i < buf.length - 1; i++) {
    if (
      i + 3 < buf.length &&
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return { split: i, bodyOffset: i + 4 };
    }
    if (buf[i] === 10 && buf[i + 1] === 10) {
      return { split: i, bodyOffset: i + 2 };
    }
  }
  return null;
}

/**
 * Bridge HTTP requests to git's native `git http-backend` CGI with streaming stdin/stdout.
 * Parses CGI headers from the opening chunk(s) only, then streams the packfile directly so
 * large clones/pushes stay O(1) in RAM.
 */
export async function handleGitHttp(req: Request, pathInfo: string): Promise<Response> {
  const url = new URL(req.url);

  const env: Record<string, string> = {
    GIT_PROJECT_ROOT: reposDir,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: pathInfo,
    REMOTE_USER: "chong",
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    CONTENT_TYPE: req.headers.get("content-type") ?? "",
    HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
  };

  const proc = Bun.spawn(["git", "http-backend"], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream request body to CGI stdin without buffering the entire pack in memory.
  const pumpStdin = (async () => {
    try {
      if (req.body && req.method !== "GET" && req.method !== "HEAD") {
        const reader = req.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) proc.stdin.write(value);
        }
      }
    } finally {
      proc.stdin.end();
    }
  })();

  const stdoutReader = proc.stdout.getReader();
  const headerChunks: Uint8Array[] = [];
  let headerBytes = 0;
  let split: { split: number; bodyOffset: number } | null = null;
  let combined = new Uint8Array(0);

  while (!split) {
    const { value, done } = await stdoutReader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    headerChunks.push(value);
    headerBytes += value.byteLength;
    combined = new Uint8Array(headerBytes);
    let off = 0;
    for (const c of headerChunks) {
      combined.set(c, off);
      off += c.byteLength;
    }
    split = findHeaderEnd(combined);
    if (!split && headerBytes > MAX_HEADER_BYTES) break;
  }

  if (!split) {
    stdoutReader.releaseLock();
    await pumpStdin.catch(() => {});
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    return new Response(`git-http-backend produced no headers: ${stderr.slice(0, 400)}`, {
      status: 502,
    });
  }

  const headerText = new TextDecoder().decode(combined.subarray(0, split.split));
  const initialBody = combined.subarray(split.bodyOffset);

  const headers = new Headers();
  let status = 200;
  for (const line of headerText.split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k.toLowerCase() === "status") {
      status = Number(v.split(" ")[0]) || 200;
    } else {
      headers.set(k, v);
    }
  }

  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (initialBody.byteLength > 0) controller.enqueue(initialBody);
    },
    async pull(controller) {
      try {
        const { value, done } = await stdoutReader.read();
        if (done) {
          controller.close();
          await pumpStdin.catch(() => {});
          await new Response(proc.stderr).text().catch(() => {});
          await proc.exited;
        } else if (value) {
          controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      stdoutReader.cancel().catch(() => {});
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(bodyStream, { status, headers });
}
