#!/usr/bin/env bun
// Claude Code PreToolUse guard: whenever an agent runs a git command that touches
// the shared index, inject guidance toward `chong commit`. Non-blocking — it only
// adds context; the real hard gate against whole-index commits is .githooks/pre-commit.
//
// Opt in (per teammate) by adding to your .claude/settings.json or settings.local.json:
//   { "hooks": { "PreToolUse": [
//     { "matcher": "Bash", "hooks": [
//       { "type": "command", "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/git-guard.ts\"" }
//     ] }
//   ] } }

const raw = await Bun.stdin.text();
let cmd = "";
try {
  cmd = (JSON.parse(raw)?.tool_input?.command as string | undefined) ?? "";
} catch {
  // not JSON / nothing to inspect
}

const touchesIndex = /\bgit\s+(add|rm|reset|commit|stash)\b/.test(cmd);
const usesChong = /\bchong\b/.test(cmd);

if (touchesIndex && !usesChong) {
  const context = [
    "Shared-worktree git safety (chong):",
    "Parallel agents may share one git index (.git/index) in this worktree. `git add`/",
    "`reset`/`rm` + `git commit` all race on it — a bare `git commit` can sweep in another",
    "agent's staged changes. Prefer an atomic commit that never touches the shared index:",
    '  chong commit -m "msg" <path>...       # commit only these paths',
    '  chong commit -m "msg" --rm <a,b>       # commit deletions',
    '  chong commit -m "msg" --patch <file>   # commit specific hunks (diff vs HEAD)',
    "Porcelain `git commit` is blocked by the pre-commit hook; only override with",
    "CHONG_ALLOW_COMMIT=1 if you truly mean to commit the entire index.",
  ].join("\n");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    }),
  );
}

process.exit(0);
