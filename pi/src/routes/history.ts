import { generateCoaching } from "../coaching";
import { config } from "../config";
import { dao } from "../db";
import { git } from "../git";
import { jsonErr } from "../util";

export async function listHistory(params: URLSearchParams): Promise<Response> {
  const repo = params.get("repo");
  const author = params.get("author") ?? undefined;
  const limit = Number(params.get("limit") ?? "50");
  if (!repo) return jsonErr(400, "repo query param required");

  const commits = await git.log(repo, { limit, author });
  return Response.json(
    commits.map((cmt) => ({
      sha: cmt.sha,
      repo,
      author: cmt.email || cmt.author,
      message: cmt.subject,
      cl_id: dao.getCLBySha(cmt.sha)?.id ?? null,
      date: cmt.date,
    })),
  );
}

export async function showCommit(
  sha: string,
  params: URLSearchParams,
): Promise<Response> {
  const repo = params.get("repo");
  if (!repo) return jsonErr(400, "repo query param required");

  const data = await git.show(repo, sha);

  let coaching: string | null = null;
  if (config.anthropicApiKey) {
    coaching = dao.getCoaching(sha);
    if (!coaching) {
      try {
        coaching = await generateCoaching(config.anthropicApiKey, {
          sha,
          repo,
          message: data.message,
          diff: data.diff,
        });
        dao.putCoaching(sha, repo, coaching);
      } catch (e) {
        // Coaching is best-effort; failure shouldn't break show.
        console.error("coaching failed:", (e as Error).message);
      }
    }
  }

  return Response.json({
    commit: {
      sha: data.sha,
      repo,
      author: data.email || data.author,
      message: data.message,
      cl_id: dao.getCLBySha(data.sha)?.id ?? null,
      date: data.date,
    },
    diff: data.diff,
    coaching,
  });
}
