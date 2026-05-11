import { reposDir } from "../config";

/**
 * Bridge HTTP requests to git's native `git http-backend` CGI.
 * Devs `git push https://<tunnel-host>/repos/<name>.git` and the protocol just works.
 *
 * v0.1: buffers request and response. Fine for an 86 MB repo with <1000 lines/hour
 * of changes; pack negotiation rarely transfers more than a few MB at a time.
 * Streaming optimization in v0.2 if push latency matters.
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

  if (req.body && req.method !== "GET" && req.method !== "HEAD") {
    const body = new Uint8Array(await req.arrayBuffer());
    proc.stdin.write(body);
  }
  proc.stdin.end();

  const all = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;

  // Parse CGI output: headers terminated by \r\n\r\n (or \n\n), then body.
  let split = -1;
  let bodyOffset = -1;
  for (let i = 0; i < all.length - 1; i++) {
    if (
      i + 3 < all.length &&
      all[i] === 13 &&
      all[i + 1] === 10 &&
      all[i + 2] === 13 &&
      all[i + 3] === 10
    ) {
      split = i;
      bodyOffset = i + 4;
      break;
    }
    if (all[i] === 10 && all[i + 1] === 10) {
      split = i;
      bodyOffset = i + 2;
      break;
    }
  }
  if (split < 0) {
    const stderr = await new Response(proc.stderr).text();
    return new Response(`git-http-backend produced no headers: ${stderr.slice(0, 400)}`, {
      status: 502,
    });
  }

  const headerText = new TextDecoder().decode(all.subarray(0, split));
  const body = all.subarray(bodyOffset);

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

  return new Response(body, { status, headers });
}
