import { dao } from "../db";
import { git } from "../git";
import type { AuthCtx } from "../types";
import { jsonErr, slugify } from "../util";

export async function createCL(
  auth: AuthCtx,
  body: { title?: string; repo?: string },
): Promise<Response> {
  if (!body.title || !body.repo) return jsonErr(400, "title and repo required");
  await git.ensureRepo(body.repo);

  const id = dao.nextCLId();
  const idLower = id.toLowerCase().replace(/^cl-?/, "");
  const slug = slugify(body.title);
  const userSlug = auth.user.replace(/[^a-zA-Z0-9._-]/g, "-");
  const branch = `chong/${userSlug}/${idLower}-${slug}`;

  dao.insertCL({
    id,
    title: body.title,
    repo: body.repo,
    branch,
    author: auth.user,
    status: "DRAFT",
  });
  return Response.json(dao.getCL(id));
}

export function listCLs(auth: AuthCtx, params: URLSearchParams): Response {
  const status = params.get("status") ?? undefined;
  const author = params.get("author") ?? auth.user;
  const repo = params.get("repo") ?? undefined;
  return Response.json(dao.listCLs({ author, status, repo }));
}

export function getCL(id: string): Response {
  const cl = dao.getCL(id);
  if (!cl) return jsonErr(404, "not found");
  return Response.json(cl);
}

export function deleteCL(auth: AuthCtx, id: string): Response {
  const cl = dao.getCL(id);
  if (!cl) return jsonErr(404, "not found");
  if (cl.author !== auth.user) return jsonErr(403, "not your CL");
  dao.abandonCL(id);
  return Response.json({ ok: true });
}

export function uploadCL(
  auth: AuthCtx,
  id: string,
  body: { sha?: string },
): Response {
  const cl = dao.getCL(id);
  if (!cl) return jsonErr(404, "not found");
  if (cl.author !== auth.user) return jsonErr(403, "not your CL");
  if (!body.sha) return jsonErr(400, "sha required");
  const sha = body.sha;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: string): void => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`));
      };
      try {
        dao.updateCL(cl.id, { status: "BUILDING", sha });
        send("step", `received ${sha.slice(0, 7)} on ${cl.branch}`);

        send("step", "merging to main…");
        const newSha = await git.squashMerge(cl.repo, cl.branch, {
          title: cl.title,
          author: cl.author,
          email: cl.author.includes("@") ? cl.author : `${cl.author}@local`,
        });
        dao.updateCL(cl.id, { status: "LIVE", sha: newSha });
        send("done", `merged ${newSha.slice(0, 7)}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send("error", msg);
        dao.updateCL(cl.id, { status: "BUILD_ERROR" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
