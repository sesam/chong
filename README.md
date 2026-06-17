# 冲 chong

> 冲 (chōng) — to push through, to rush forward, to clear the way.

A CLI for watching and managing a git promotion pipeline (main → stage → prod). Works standalone with just git, with optional deeper integration via a Harness account.

## Requirements

- [Bun](https://bun.sh) (runtime + build)
- Git
- `gh` CLI (optional — used for CI status badges and merge operations in `chong watch`)
- `pnpm` in the watched repo (optional — for i18n/format auto-fix in `chong watch`)

## Install

```sh
git clone https://github.com/sesam/chong.git
cd chong
bun run build
ln -sf $PWD/chong ~/bin/chong   # or wherever your $PATH includes
```

---

## Part 1 — works without any account

### `chong watch [<path>] [options]`

Live TUI for your promotion pipeline. Point it at any git repo and it shows commits queuing through your branches, lets you promote between them, and runs automated post-commit checks.

```
Options:
  --branches main,stage,prod   branch names for the pipeline (default: main,stage,prod)
  --interval <seconds>         poll interval (default: 15)
  --remote <name>              git remote (default: origin)
  --format-cmd <cmd>           formatter for shadow auto-fix (default: pnpm format)
  --test-cmd <cmd>             unit-test command for maintenance (default: pnpm test)
  --i18n-cmd <cmd>             i18n command for maintenance (default: pnpm i18n)
```

![chong watch TUI](chong-watch-tui-example.webp)

**TUI keys:** `[s]` promote → stage · `[p]` promote → prod · `[↑/↓]` select · `[space]` queued commits · `[m]` maintenance · `[f]` fetch · `[r]` CI · `[q]` quit

**INCOMING** shows your local branch and remote origin/main commits merged by time. Commits that arrived after `chong watch` started are highlighted green.

**Post-commit checks** run automatically on each new remote commit:
- Flags i18n mismatches: `t()`/`useT`/`i18n` code without `.po`/`.pot` changes, or vice versa
- Resets a `main-shadow` worktree to origin/main, runs `pnpm i18n`, commits `.po`/`.pot` changes as `FIX: pnpm i18n` and pushes
- Runs the format command on the changed files, commits as `FIX: code formatting` and pushes
- Shows a modal in the TUI if leftover files remain after the i18n fix

**Maintenance** (`[m]`) runs a manual pass in the `main-shadow` worktree:
1. Applies minor (same-major) `pnpm outdated` updates and commits `CLEAN: bump minor deps`
2. Runs the formatter and commits `CLEAN: code style`
3. Runs `pnpm test` — if any unit tests break, shows a short, copy-friendly LLM prompt scoped to just the broken test file(s) (so the LLM can fix and re-run only those, not the whole suite)
4. Runs `pnpm i18n` — if it errors or leaves the tree dirty, shows a copy-friendly LLM prompt to finish the translations

Steps 1–2 commit with a `CLEAN:` prefix and push; those commits are skipped by the post-commit checks. The prompts are printed flush-left and color-free so they paste cleanly. Press `[esc]` to return to the pipeline, `[m]` to re-run.

### `chong shadow-work [<path>] [options]`

Manually trigger the same i18n + format checks against the latest origin/main commit — useful for debugging or re-running after a failure.

```
Options:
  --remote <name>       git remote (default: origin)
  --format-cmd <cmd>    formatter command (default: pnpm format)
```

### How `main-shadow` works

For each new remote commit, chong creates (or resets) a git worktree called `main-shadow` as a sibling of the watched repo:

```
~/projects/
  my-repo/         ← watched repo
  main-shadow/     ← chong's worktree, always at origin/main
```

`node_modules` is symlinked from the source repo (same lockfile, no reinstall). Auto-fix commits are tagged `FIX:` and skipped on re-check to avoid loops.

---

## Part 2 — additional features with a Harness account

[Harness](https://harness.io) has a free tier. These commands integrate with its git backend for change-list tracking, squash-merge workflows, and AI commit coaching.

### `chong auth login`
Save your Harness server URL and personal access token to `~/.chong/auth.json`.
Requires a PAT with repo + pull-request scope.

### `chong new "<title>" [--repo <name>]`
Create a change-list: makes a branch + worktree off the latest main and registers it with Harness.

### `chong upload`
Format, push, and squash-merge the current change-list to main via Harness.

### `chong status`
List your open change-lists (local worktrees + Harness remote).

### `chong abandon [<id>]`
Drop a change-list — removes the worktree, branch, and Harness record.

### `chong history [--repo <name>] [--author <user>]`
Recent commits on main, fetched from Harness.

### `chong show <sha|--latest> [--repo <name>]`
Show a commit with its diff and AI coaching notes from Harness.

---

## Development

```sh
bun run build      # compile binary
bun run lint       # biome check
bun run lint:fix   # biome check --write
```

### Auto-rebuild on commit (optional)

A tracked `post-commit` hook in `.githooks/` recompiles `./chong` after every commit, so a binary you've symlinked onto your `$PATH` stays in sync with the source. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

The hook finds `bun` via `$PATH` (falling back to `~/.bun/bin`, Homebrew, or `/usr/local/bin`) — no machine-specific paths. To opt out, run `git config --unset core.hooksPath`.
