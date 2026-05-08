# chong — Plan

`chong` (冲) is the developer-facing CLI for our company-wide Harness Open Source git
backend. It is the rebrand of the `cl` CLI described in the linked design doc
(Harness backend → `chong-server` orchestrator → `chong` CLI; pipeline is
lint → typecheck → push → build → deploy → squash-merge to `main`; no review step).

This document covers one piece the upstream design doc left open: **what happens
to the developer's local repo state across successive chongs.** Two viable
models, plus the v1 choice.

---

## Local branch UX — two viable models

### Option A — auto-rotate branches in a single working directory

One repo clone. After a successful `chong upload`:

```
git fetch origin
git checkout main && git pull --ff-only
git branch -D <old chong branch>           # already squash-merged + deleted upstream
git checkout -b chong/<author>/<next-id>   # if `chong new` was passed a title
```

**Pros**
- Single working directory; matches how most devs already use git.
- Editor and terminal stay where they are.
- No extra disk usage.

**Cons**
- Must check the working tree is clean before rotating; mid-edit work has to be
  stashed or committed.
- More edge cases to handle: dirty tree, detached HEAD, branch-name collision,
  ff-only failure.
- "Always off latest upstream" is a discipline, not a structural guarantee.

### Option B — worktree per chong (chosen for v1)

Each `chong new "title"` does:

```
git fetch origin
git worktree add -b chong/<author>/<id>-<slug> \
    .chong/wt/<id>-<slug> origin/main
```

The dev `cd`s into that worktree, edits there, and runs `chong upload` from it.
On success, `chong` cleans up:

```
git worktree remove .chong/wt/<id>-<slug>
git branch -D chong/<author>/<id>-<slug>   # idempotent; upstream is already gone
```

**Pros**
- Each chong is a fresh worktree branched directly off the latest `origin/main`
  — "always off latest upstream" is a structural guarantee, not a convention.
- The state of the main checkout is irrelevant. No "is the working tree clean?"
  branch in the code.
- Multiple chongs can exist in parallel directories without conflict.
- Cleanup is one `git worktree remove`.

**Cons**
- Dev has to `cd` once per chong (CLI prints the path; shell integration can
  follow later).
- Slightly more disk per active chong.

### Why B for v1

Fewer edge cases in the implementation, and the upstream-freshness invariant
falls out of the design rather than relying on dev discipline. Option A remains
documented and can be added later behind `chong new --inplace` if devs prefer it.

---

## v1 scope (CLI only, model B)

Working directory: `/Users/simonbohlin/42b/chong`.

Assumes `chong-server` already exists (or is mocked) with the API surface from
the linked plan. v1 builds **only the CLI** against that API.

Commands:

| Command | Behavior |
|---|---|
| `chong auth login` | Browser flow → Harness PAT → `~/.chong/auth.json` |
| `chong new "<title>" [--repo <name>]` | `POST /api/cls`; `git fetch`; `git worktree add` off `origin/main`; print the path to `cd` into |
| `chong upload` | Run from inside a worktree. Calls `POST /api/cls/:id/upload`, streams SSE log to terminal, on success removes the worktree + local branch |
| `chong status` | Lists open chongs (from server) + the local worktree mapping |
| `chong abandon` | `DELETE /api/cls/:id` + remove worktree + delete local branch |
| `chong history [--repo …]` | `GET /api/history` |
| `chong show <sha\|--latest>` | `GET /api/commit/:sha` (diff + AI coaching) |

State on disk:

- `~/.chong/auth.json` — server URL + PAT
- `<repo>/.chong/wt/<id>-<slug>/` — worktrees (gitignored at the repo level via
  `.chong/` entry)
- `<repo>/.chong/state.json` — local map of `id → { branch, worktree_path }` so
  `chong upload` and `chong status` can resolve the current worktree

Build target: single binary via `bun build --compile`.

---

## Decisions (locked in 2026-05-08)

- **Stacked CLs**: out of scope. Each chong is independent.
- **Code review**: out of scope. No PR approvals, no review UI, no comments.
  `chong upload` is the only path to `main`; the Worker bypasses the
  approval rule via a service-account PAT.
- **chong-server runtime**: Cloudflare Worker (Hono + D1). Option B from the
  design discussion: lint/typecheck/build run client-side inside `chong
  upload`; the Worker handles deploy, Harness squash-merge, metadata, history,
  and coaching. No shell on the server.
- **Auto-fix commits** appear locally — formatter runs in the worktree before
  push — not server-side. Devs see what got fixed in `git log`.
- **Formatter** = Prettier, bundled into the `chong` CLI binary. Not user-
  configurable: `.prettierrc` and `package.json#prettier` are ignored.
  Hardcoded options bias toward minimal merge-conflict surface — trailing
  commas everywhere, conservative wrapping. The dev never installs Prettier
  separately.
- **User auth on the Worker** = the user's Harness PAT as the bearer token,
  validated each request via Harness `GET /api/v1/user`. The Worker also
  carries a separate service-account PAT for the merge bypass.

## Repo layout

```
/Users/simonbohlin/42b/chong/
├── PLAN.md
├── package.json + src/      # CLI (built earlier)
└── server/                  # Cloudflare Worker (this round)
    ├── wrangler.toml
    ├── schema.sql
    └── src/
```
