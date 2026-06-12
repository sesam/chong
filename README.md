# 冲 chong

> 冲 (chōng) — to push through, to rush forward, to clear the way.

A CLI for shipping change-lists through a git promotion pipeline (main → stage → prod), built on top of Harness and standard git.

## Requirements

- [Bun](https://bun.sh) (runtime + build)
- Git
- `gh` CLI (optional — used for CI status and merge operations in `chong watch`)
- `pnpm` in the watched repo (for `shadow-work` auto-fix features)

## Install

```sh
git clone https://github.com/sesam/chong.git
cd chong
bun run build          # compiles to ./chong binary
ln -sf $PWD/chong ~/bin/chong   # or wherever your $PATH includes
```

## Commands

### `chong auth login`
Save your Harness server URL and personal access token to `~/.chong/auth.json`.
Requires a PAT with repo + pull-request scope.

### `chong new "<title>" [--repo <name>]`
Create a new change-list: makes a branch + worktree off the latest main, and registers it with the Harness backend.

### `chong upload`
Format, push, and squash-merge the current change-list to main.

### `chong status`
List your open change-lists (local worktrees + remote).

### `chong abandon [<id>]`
Drop a change-list — removes the worktree, branch, and server record.

### `chong history [--repo <name>] [--author <user>]`
Recent commits on main.

### `chong show <sha|--latest> [--repo <name>]`
Show a commit with its diff and AI coaching notes.

### `chong watch [<path>] [options]`
Live TUI for the promotion pipeline. Shows commits queuing through main → stage → prod, lets you promote between branches, and runs automated post-commit checks.

```
Options:
  --branches main,stage,prod   pipeline branch names (default: main,stage,prod)
  --interval <seconds>         poll interval (default: 15)
  --remote <name>              git remote (default: origin)
  --format-cmd <cmd>           formatter to run in shadow checks (default: pnpm format)
```

**TUI keys:** `[s]` promote → stage · `[p]` promote → prod · `[↑/↓]` select gap · `[space]` toggle queued commits · `[f]` fetch · `[r]` refresh CI · `[q]` quit

**INCOMING section** shows local branch commits and remote origin/main commits merged by time. Commits that arrived after `chong watch` started are highlighted with a green background.

**Post-commit checks** (runs automatically on each new remote commit):
- Flags i18n mismatches: `t()`/`useT`/`i18n` code added without `.po`/`.pot` changes, or vice versa
- Sets up a `main-shadow` git worktree (sibling of the watched repo), runs `pnpm i18n`, commits `.po`/`.pot` changes as `FIX: pnpm i18n` and pushes
- Runs the format command, commits formatting fixes for the changed files, pushes
- Shows a modal if leftover files remain after the i18n fix

### `chong shadow-work [<path>] [options]`
Manually trigger the same i18n + format checks that `chong watch` runs automatically, against the latest `origin/main` commit. Useful for debugging or re-running after a failure.

```
Options:
  --remote <name>       git remote (default: origin)
  --format-cmd <cmd>    formatter command (default: pnpm format)
```

## How `main-shadow` works

For each new remote commit, chong creates (or resets) a git worktree called `main-shadow` as a sibling of the watched repo:

```
~/projects/
  my-repo/         ← watched repo
  main-shadow/     ← chong's worktree, always at origin/main
```

The worktree's `node_modules` is symlinked from the source repo (same lockfile, no reinstall needed). Auto-fix commits are tagged `FIX:` and skipped on subsequent checks to avoid loops.

## Development

```sh
bun run build      # compile binary
bun run lint       # biome check
bun run lint:fix   # biome check --write
```
