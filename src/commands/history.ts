import { api } from "../api";
import { c, parseArgs } from "../util";

export async function cmdHistory(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const list = await api.history({
    repo: flags.repo as string | undefined,
    author: flags.author as string | undefined,
  });

  if (list.length === 0) {
    console.log(c.dim("no commits"));
    return;
  }

  for (const commit of list.slice(0, 20)) {
    const tag = commit.cl_id ? c.cyan(commit.cl_id) : c.dim("       ");
    const subject = commit.message.split("\n")[0];
    console.log(`  ${commit.sha.slice(0, 7)}  ${tag}  ${subject}`);
    console.log(c.dim(`           ${commit.author}  ${commit.date}`));
  }
}
