/**
 * Headless coding-agent helpers for chong watch.
 *
 * Prefers offline `mcpify-agent` (Ollama + mcp-ify) when on PATH; falls back to
 * Cursor Agent (`agent` / `cursor-agent`) with `--model auto`.
 *
 * Confidence gates use ask/read-only mode; edits use force/agent mode.
 */

export type AgentRun = {
  ok: boolean;
  /** Final assistant text (json `result` field), or stderr/error. */
  text: string;
  exitCode: number;
};

export type Verdict = "SAFE" | "UNSAFE" | "UNKNOWN";

export type AgentKind = "mcpify-agent" | "cursor-agent";

const AGENT_TIMEOUT_MS = 8 * 60 * 1000; // conflict/i18n resolves can take a few minutes

export type FoundAgent = { bin: string; kind: AgentKind };

/** Resolve the preferred agent CLI, or null if none on PATH. */
export function findAgent(): FoundAgent | null {
  const mcpify = Bun.which("mcpify-agent");
  if (mcpify) return { bin: mcpify, kind: "mcpify-agent" };
  const cursor = Bun.which("agent") ?? Bun.which("cursor-agent");
  if (cursor) return { bin: cursor, kind: "cursor-agent" };
  return null;
}

/** @deprecated use findAgent() */
export function findAgentBin(): string | null {
  return findAgent()?.bin ?? null;
}

/** Parse a machine verdict line from agent text. */
export function parseVerdict(text: string): Verdict {
  const m = text.match(/\bVERDICT:\s*(SAFE|UNSAFE)\b/i);
  if (!m) return "UNKNOWN";
  return m[1].toUpperCase() === "SAFE" ? "SAFE" : "UNSAFE";
}

function buildArgs(
  kind: AgentKind,
  workspace: string,
  prompt: string,
  mode: "ask" | "agent",
): string[] {
  if (kind === "mcpify-agent") {
    const args = [
      "-p",
      "--workspace",
      workspace,
      "--output-format",
      "json",
      "--mode",
      mode === "ask" ? "ask" : "agent",
    ];
    if (mode === "agent") args.push("--force");
    args.push(prompt);
    return args;
  }

  // cursor-agent / agent
  const args = [
    "-p",
    "--model",
    "auto",
    "--trust",
    "--workspace",
    workspace,
    "--output-format",
    "json",
  ];
  if (mode === "ask") args.push("--mode", "ask");
  else args.push("--force");
  args.push(prompt);
  return args;
}

/**
 * Run the agent headlessly. `mode: "ask"` is read-only; `mode: "agent"` edits.
 */
export async function runAgent(
  workspace: string,
  prompt: string,
  mode: "ask" | "agent" = "agent",
): Promise<AgentRun> {
  const found = findAgent();
  if (!found) {
    return {
      ok: false,
      text: "no agent on PATH (install mcpify-agent from mcp-ify/offline-agent, or cursor-agent)",
      exitCode: 127,
    };
  }

  const args = buildArgs(found.kind, workspace, prompt, mode);

  const proc = Bun.spawn([found.bin, ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
    },
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, AGENT_TIMEOUT_MS);

  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      return {
        ok: false,
        text: (err || out || `agent exited ${code}`).trim().slice(0, 800),
        exitCode: code,
      };
    }
    const trimmed = out.trim();
    try {
      const json = JSON.parse(trimmed) as { result?: string; is_error?: boolean };
      if (json.is_error) {
        return { ok: false, text: String(json.result ?? "agent error"), exitCode: code };
      }
      return { ok: true, text: String(json.result ?? ""), exitCode: code };
    } catch {
      return { ok: true, text: trimmed, exitCode: code };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Ask-mode confidence gate; returns the verdict + raw text. */
export async function agentGate(
  workspace: string,
  prompt: string,
): Promise<{ verdict: Verdict; text: string; ok: boolean }> {
  const run = await runAgent(workspace, prompt, "ask");
  if (!run.ok) return { verdict: "UNKNOWN", text: run.text, ok: false };
  return { verdict: parseVerdict(run.text), text: run.text, ok: true };
}

/** Force-mode edit run. */
export async function agentEdit(workspace: string, prompt: string): Promise<AgentRun> {
  return runAgent(workspace, prompt, "agent");
}

// ── prompt builders ──────────────────────────────────────────────────────────

export function cherryPickGatePrompt(shaShort: string): string {
  return [
    `A git cherry-pick of commit ${shaShort} is in progress in this worktree (CHERRY_PICK_HEAD is set).`,
    "Inspect only the conflicted files and the commit being applied.",
    "Is resolving this a safe mechanical replay of that commit onto the current tip (both sides recent; no intentional divergent product decisions)?",
    "Reply with exactly one final line:",
    "VERDICT: SAFE — <short reason>",
    "or",
    "VERDICT: UNSAFE — <short reason>",
  ].join("\n");
}

export function cherryPickResolvePrompt(shaShort: string): string {
  return [
    `Finish the in-progress git cherry-pick of ${shaShort} in this worktree.`,
    "Resolve conflict markers so both sides' intent composes; when the base only reformatted/moved code, prefer the cherry-picked commit's hunks.",
    "Do not push. Do not reset --hard. Do not abort.",
    "When done: git add the resolved paths, then git -c core.editor=true cherry-pick --continue.",
    "If you are not confident, stop and leave the conflicts as-is.",
  ].join("\n");
}

export function i18nGatePrompt(summary: string): string {
  return [
    "Chong maintenance found i18n issues in this worktree:",
    summary,
    "",
    "Can these be fixed safely and mechanically (wrap clear user-facing strings in t(), fill obvious msgstr, run the project's i18n command) without guessing product copy or changing behavior?",
    "Reply with exactly one final line:",
    "VERDICT: SAFE — <short reason>",
    "or",
    "VERDICT: UNSAFE — <short reason>",
  ].join("\n");
}

export function i18nResolvePrompt(summary: string, i18nCmd: string): string {
  return [
    "Fix the i18n issues below in this worktree. Be conservative.",
    summary,
    "",
    "Rules:",
    "- Only wrap genuine user-facing copy in t() / $t; skip logs, throws, tests, fixtures, data modules.",
    `- After edits, run \`${i18nCmd}\` and fill new/empty msgstr entries when the source string is clear.`,
    "- Do not push. Do not rewrite unrelated files.",
    "- If anything is ambiguous, leave it untouched and stop.",
    "When done, leave a clean tree for the files you intentionally fixed (or stop if unsure).",
  ].join("\n");
}
