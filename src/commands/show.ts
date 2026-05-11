import { api } from "../api";
import { defaultRepo } from "../repo";
import { c, parseArgs } from "../util";

export async function cmdShow(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  let sha = positional[0];

  const repo = (flags.repo as string | undefined) ?? (await defaultRepo());
  if (!repo) {
    console.error(
      c.red("✗ could not determine repo — pass --repo or add .chong/config.json with { \"repo\": \"...\" }"),
    );
    process.exit(1);
  }

  if (flags.latest === true || sha === "--latest") {
    const list = await api.history({ repo });
    if (list.length === 0) {
      console.error(c.red("no commits"));
      process.exit(1);
    }
    sha = list[0].sha;
  }

  if (!sha) {
    console.error(c.red("usage: chong show <sha> [--repo <name>]   |   chong show --latest [--repo <name>]"));
    process.exit(1);
  }

  const data = await api.commit(sha, repo);
  const subject = data.commit.message.split("\n")[0];
  console.log(c.bold(`${data.commit.sha.slice(0, 7)}  ${subject}`));
  console.log(c.dim(`${data.commit.author}  ${data.commit.date}`));
  if (data.commit.cl_id) console.log(c.cyan(data.commit.cl_id));

  console.log("");
  console.log(c.dim("---- diff ----"));
  console.log(data.diff);

  if (data.coaching) {
    console.log("");
    console.log(c.dim("---- coaching ----"));
    if (typeof data.coaching === "string") {
      console.log(data.coaching);
    } else {
      console.log(JSON.stringify(data.coaching, null, 2));
    }
  }
}
