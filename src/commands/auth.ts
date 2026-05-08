import { writeAuth } from "../config";
import { ask, c } from "../util";

export async function authLogin(_argv: string[]): Promise<void> {
  console.log(c.bold("chong auth login"));
  console.log(
    c.dim(
      "Open your Harness instance → profile → personal access tokens → create one with repo + pullreq scope.",
    ),
  );

  const server = ask("Harness URL (e.g. https://git.yourcompany.com): ");
  const token = ask("Personal Access Token: ");
  if (!server || !token) {
    console.error(c.red("✗ url and token both required"));
    process.exit(1);
  }

  const base = server.replace(/\/+$/, "");
  const r = await fetch(`${base}/api/v1/user`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    console.error(c.red(`✗ auth check failed: ${r.status}`));
    process.exit(1);
  }
  const u = (await r.json()) as { uid?: string; email?: string; display_name?: string };
  const user = u.uid ?? u.email ?? u.display_name ?? "unknown";

  await writeAuth({ server: base, token, user });
  console.log(c.green(`✓ logged in as ${user}`));
}
