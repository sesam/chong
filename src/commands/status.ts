import { api } from "../api";
import { readState } from "../state";
import { c } from "../util";

export async function cmdStatus(_argv: string[]): Promise<void> {
  const state = await readState();
  const localIds = Object.keys(state.cls);

  if (localIds.length === 0) {
    let remote: Awaited<ReturnType<typeof api.listCLs>> = [];
    try {
      remote = await api.listCLs({});
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
    if (remote.length === 0) {
      console.log(c.dim("no open chongs"));
      return;
    }
    for (const cl of remote) {
      console.log(`  ${c.bold(cl.id)}  ${pad(cl.status, 12)}  ${cl.title}`);
    }
    return;
  }

  for (const id of localIds) {
    const local = state.cls[id];
    let status = "?";
    try {
      const remote = await api.getCL(id);
      status = remote.status;
    } catch {
      status = "OFFLINE";
    }
    console.log(`  ${c.bold(id)}  ${pad(status, 12)}  ${local.title}`);
    console.log(c.dim(`         ${local.worktree}`));
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
