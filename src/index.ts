#!/usr/bin/env bun
import { cmdAbandon } from "./commands/abandon";
import { authLogin } from "./commands/auth";
import { cmdCheck } from "./commands/check";
import { cmdCommit } from "./commands/commit";
import { cmdHistory } from "./commands/history";
import { cmdNew } from "./commands/new";
import { cmdShadowWork } from "./commands/shadow-work";
import { cmdShow } from "./commands/show";
import { cmdStatus } from "./commands/status";
import { cmdUpload } from "./commands/upload";
import { cmdWatch } from "./commands/watch";
import { c } from "./util";

const HELP = `chong — ship change-lists to the company git backend

  chong commit -m "<msg>" [<path>...] [--rm <a,b>] [--patch <file>]
                                        atomic commit that bypasses the shared git
                                        index — safe alongside parallel agents in the
                                        same worktree
  chong new "<title>" [--repo <name>]   create a CL + worktree off latest main
  chong upload                          format, push, squash-merge to main
  chong status                          your open chongs (local + remote)
  chong abandon [<id>]                  drop a chong (worktree + branch + server)
  chong history [--repo <name>] [--author <u>]
                                        recent commits on main
  chong show <sha> [--repo <name>]      commit + diff + AI coaching
  chong show --latest [--repo <name>]   most recent commit on main
  chong watch [<path>] [--branches main,stage,prod] [--interval <s>] [--remote <r>]
              [--format-cmd <cmd>]      live TUI of commits queueing through the
                                        promotion pipeline; promote between branches
  chong shadow-work [<path>] [--remote <r>] [--format-cmd <cmd>]
                                        manually run i18n + format checks on the
                                        latest origin/main commit via main-shadow
  chong check i18n [<path>] [--json]    list hardcoded user-facing strings not
                                        wrapped in t() (detection feedback view)
  chong auth login                      save server URL + PAT to ~/.chong/auth.json
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  switch (cmd) {
    case "auth": {
      const sub = rest[0];
      if (sub === "login") return await authLogin(rest.slice(1));
      console.error(c.red(`unknown auth subcommand: ${sub ?? "(none)"}`));
      process.exit(1);
    }
    case "commit":
      return await cmdCommit(rest);
    case "new":
      return await cmdNew(rest);
    case "upload":
      return await cmdUpload(rest);
    case "status":
      return await cmdStatus(rest);
    case "abandon":
      return await cmdAbandon(rest);
    case "history":
      return await cmdHistory(rest);
    case "show":
      return await cmdShow(rest);
    case "watch":
      return await cmdWatch(rest);
    case "shadow-work":
      return await cmdShadowWork(rest);
    case "check":
      return await cmdCheck(rest);
    default:
      console.error(c.red(`unknown command: ${cmd}`));
      process.stdout.write(HELP);
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(c.red(`✗ ${msg}`));
  process.exit(1);
});
