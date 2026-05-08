import { existsSync } from "node:fs";
import { join } from "node:path";
import { api } from "../api";
import { git } from "../git";
import { readState, writeState } from "../state";
import { c, parseArgs, slugify } from "../util";

export async function cmdNew(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const title = positional.join(" ").trim();
  if (!title) {
    console.error(c.red('usage: chong new "<title>" [--repo <name>]'));
    process.exit(1);
  }

  const repo = (flags.repo as string | undefined) ?? (await defaultRepo());
  if (!repo) {
    console.error(
      c.red("✗ could not determine repo — pass --repo or add .chong/config.json with { \"repo\": \"...\" }"),
    );
    process.exit(1);
  }

  const cl = await api.createCL({ title, repo });

  const slug = slugify(title);
  const idLower = cl.id.toLowerCase().replace(/^cl-?/, "");
  const wtRel = join(".chong", "wt", `${idLower}-${slug}`);
  const main = await git.mainWorktree();
  const wtAbs = join(main, wtRel);

  await git.fetch();
  await git.worktreeAdd(wtAbs, cl.branch, "origin/main");

  const state = await readState();
  state.cls[cl.id] = {
    id: cl.id,
    title,
    repo,
    branch: cl.branch,
    worktree: wtRel,
    created_at: new Date().toISOString(),
  };
  await writeState(state);

  console.log(c.green(`✓ ${cl.id}  ${title}`));
  console.log(c.dim(`  repo:    ${repo}`));
  console.log(c.dim(`  branch:  ${cl.branch}`));
  console.log("");
  console.log(`  cd ${wtRel}`);
}

async function defaultRepo(): Promise<string> {
  try {
    const main = await git.mainWorktree();
    const cfgPath = join(main, ".chong", "config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(await Bun.file(cfgPath).text()) as { repo?: string };
      if (cfg.repo) return cfg.repo;
    }
  } catch {
    // not in a git repo / no config
  }

  try {
    const url = await git.remoteUrl();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
    }
    if (url.startsWith("git@")) {
      return url.replace(/^git@[^:]+:/, "").replace(/\.git$/, "");
    }
  } catch {
    // no remote
  }
  return "";
}
