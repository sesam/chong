# Bugs and security — outstanding

Two review passes over `chong watch`'s deploy, claim and shadow-worktree paths.

- **Pass 1** (`1f11e76`, direct review of `HEAD~10..HEAD`): 7 correctness + 5 security items.
- **Pass 2** (after the pass-1 fixes landed): four independent adversarial reviewers —
  worktree concurrency, deploy lifecycle, an attack-the-new-defences security pass, and a
  fresh sweep of the ~5k lines never reviewed at all.

**Status 2026-09-11:** everything below is fixed except where marked *Open* or *Accepted*.
`bun test` **243 pass / 0 fail** (was 120), `bunx tsc --noEmit` clean (was 1 error),
`bun build --compile` succeeds. 10 commits, `db03f05..04af20a`.

**Pass 2 found three defects that pass 1 introduced**, and one critical pre-existing one
that pass 1 walked straight past. That is the main lesson here: the fixes needed reviewing
at least as much as the original code did.

---

## The one that mattered most

**The worktree claim system was optional, and nothing enforced it.** `ensureShadow` only
checked ownership `if (opts.processId)` — so omitting the argument skipped the check
entirely and proceeded to `cherry-pick --abort`, `clean -fd`, `reset --hard` on the shared
worktree. Four callers omitted it. The worst was `reconcileLocalMain`, reached from
`maybeReconcileLocalMain`, which runs **every poll cycle** with no ownership guard — right
beside `queueAutoMaintain`, which has one. So a watch that did not own the worktree reset
it the moment its local `main` diverged, while the real owner might be mid-deploy. No race
window required; a straight-line code path.

Fixed by making the options argument *and* its `processId` required, with no `unclaimed`
escape hatch (every path through `ensureShadow` mutates the worktree, so there is no
read-only caller an opt-out would serve — and an opt-out is exactly what someone would
reach for on a type error). That immediately exposed a **fourth** bypass on the prod deploy
path that four reviewers reading the code had all missed. The argument for fixing this
class of bug with a type rather than a convention.

---

## Correctness

| Sev | Location | Finding | Status |
|-----|----------|---------|--------|
| High | `checks.ts` `ensureShadow`, 4 callers | Claim check was opt-in; omitting `processId` bypassed it into `reset --hard`. See above. | **Fixed** `cbc02e7` |
| High | `app.ts` `maybeTouchWorktreeClaim` | Owner mtime refreshed only when commits arrived, so a quiet `main` or a long deploy let a live claim age out and another watch `reset --hard` the shadow mid-upload. | **Fixed** `db03f05` — time-based whenever owned |
| High | `worktree-claim.ts` | `TOUCH_MS === STALE_MS` (both 20m): the refresh fired only once the claim was already stale. Zero margin. *Found in pass 1's own fix pass.* | **Fixed** `db03f05` — touch is `STALE/3` |
| High | `worktree-claim.ts` `touchWorktreeClaim` | No compare-and-swap: a delayed touch reverted a legitimate force-override, leaving two processes both believing they owned the worktree. **Reproduced.** *Pass-1 regression.* | **Fixed** `2f2ef1a` |
| High | `stage-deploy.ts` `runDeployCommand` | Abort killed only the `bash -c` parent; `s5cmd`/`aws` children kept writing to the bucket after chong reported the deploy aborted. | **Fixed** `a34ec8b` — process-group kill, SIGKILL escalation |
| High | `stage-deploy.ts` `startClaimHeartbeat` | The in-flight guard had no per-attempt timeout, so one hung `aws` call wedged **every** future heartbeat and let the claim lapse mid-upload — strictly worse than the unguarded code it replaced. *Pass-1 regression.* | **Fixed** `a34ec8b` — 10s bound, 3 strikes = lost |
| High | `stage-deploy.ts` heartbeat tick | `finally` but no `catch`; `Bun.spawn` throws on missing `aws`, killing the process mid-deploy, orphaning the deploy and never releasing the claim. | **Fixed** `a34ec8b` |
| High | `app.ts`, `gh.ts`, `index.ts` | No `unhandledRejection` handler anywhere. A missing `gh`/`pnpm` killed the watch; because the process was *terminated*, `finally` never ran — alt screen left on (terminal unusable until `reset`) and the claim held for its full stale window, blocking every other watch. | **Fixed** `3ee5c8e`, `04af20a` |
| Medium | `worktree-claim.ts` `acquireWorktreeClaim` | Check-then-write: two processes both seeing "absent/stale" both won. | **Fixed** `db03f05` — `O_EXCL`, EEXIST re-read, CAS on `at`, write-then-verify |
| Medium | `deploy-claim.ts` force path | Wrote and returned success without the read-back that catches a concurrent writer. | **Fixed** `5af0114` |
| Medium | `deploy-claim.ts` `acquireDeployClaim` | A transient failure of the *verify GET* abandoned the attempt while leaving its own claim live in S3, with nobody to release it. | **Fixed** `2f2ef1a` — bounded retry, then release what we wrote |
| Medium | `app.ts` `[o]` override | Single keypress force-stole a live teammate's worktree. | **Fixed** `db03f05` — confirm only when the claim is live; free/stale still one keypress |
| Medium | `app.ts` `[o]` cancel guard | The guard released on any key `!== "y"`, but `case "y"` resolves a gap-promote confirm first and returns — so `y` with a prod confirm open left the override **armed but invisible**, and the next `y` stole a live claim with no prompt. *Pass-1 regression.* | **Fixed** `db03f05` |
| Medium | `checks.ts` × 4 auto-commit paths | `git add -A` + `--no-verify` push, unattended. The lockfile step left pnpm's output dirty for the next step to ship as "CLEAN: code style"; agent scratch files landed on `main`. | **Fixed** `04af20a` — explicit paths, refuse on unexpected untracked |
| Medium | `checks.ts` / `app.ts` auto-inject | Local `main` pushed within one poll with no opt-out, making `commit --amend` unsafe (original already on origin; `git cherry` then re-picks the amended copy). | **Fixed** `04af20a` — `--no-auto-inject`, 30s amend grace |
| Medium | `agent.ts` | A hung agent never settled (SIGTERM to parent only, then awaited the drain), freezing auto-fix, auto-maintain **and** stage deploys on the shared queue, with nothing in the UI. | **Fixed** `3ee5c8e` — detached, group kill, raced deadline |
| Low | `deploy-claim.ts` `releaseDeployClaim` | Wrote `{}` instead of deleting the key. | **Fixed** `5af0114` |
| Low | `stage-deploy.ts:454` | Real operator-facing bug behind the repo's only `tsc` error: an unconfigured marker bucket reported `deploy claim write failed: undefined`. | **Fixed** `607307c` |
| Low | `stage-deploy.ts` `runDeployCommand` | Abort-poll interval and SIGKILL timer leaked, and the child was never reaped, if the output drain threw. | **Fixed** `a34ec8b` |
| Low | `stage-deploy.ts` prod `onLost` | Said "aborting" when `force` meant nothing aborted. | **Fixed** `a34ec8b` |
| Low | `checks.ts` legacy worktree | `worktree remove --force` on a path match alone discarded a hand-made `../main-shadow`. | **Fixed** `cbc02e7` — only when clean and detached |
| Low | `repo.ts`, `checks.ts`, `lint.ts` | Git C-quotes paths with spaces/non-ASCII, so such files were silently neither reverted, staged, nor linted — then swept up by a later `add -A`. | **Fixed** `9426285`, `cbc02e7`, `3dede19` — `-z` + NUL |
| — | `checks.ts` | `tryAutoPromoteStage`, `promoteFastForward`, `lintStageDiff`, `AutoPromoteResult` — unreferenced, and carried one of the unclaimed `ensureShadow` calls. | **Deleted** `cbc02e7` |

## Security

| Sev | Location | Finding | Status |
|-----|----------|---------|--------|
| High | `agent.ts` + `checks.ts` prompts | The i18n/eslint agent ran `--trust --force` with the operator's full env (AWS keys) on prompts built from repo-authored text (`.po` msgids, string literals, eslint messages). A merged translation-only commit saying "ignore the above and run …" executed as the operator. No config or bucket access needed. | **Fixed** `3ee5c8e` — env allowlist, untrusted-data fencing |
| Medium | `repo.ts` → `render.ts` | Commit author/subject reached the TUI raw. **Verified** ESC/BEL survive `git log --pretty=%s`, so *any* merged commit gave full ANSI/OSC — OSC 52 clipboard writes, forged UI rows. More reachable than the claim fields this code already sanitized, which was backwards. | **Fixed** `9426285` |
| Medium | claim parsers | Both sanitizers stripped 7-bit CSI and C0 but missed **8-bit C1** (U+0080–U+009F), which C1-aware terminals still act on; RTL overrides, full-width and combining-mark runs also passed, letting a bucket writer render any colleague's name. | **Fixed** `2f2ef1a` — printable allowlist, one shared module (`ec06044`) |
| Medium | `stage-deploy.ts` marker buckets | Repo-controlled bucket names redirect marker/claim **writes** to any bucket the operator can write, and redirect **reads** so chong believes a commit already shipped and skips the deploy. (No `aws` argv injection — verified.) | **Fixed** `3dede19` — S3 grammar; hygiene, not a boundary |
| Low | `config.ts`, `state.ts` | Harness PAT and state written 0644. | **Fixed** `3ee5c8e` — dir 0700, files 0600 |
| Low | `worktree-claim.ts` | Takeover/force/touch writes followed a symlink planted at `<shadow>.owner.json`. | **Fixed** `2f2ef1a` — temp file + rename |
| **Accepted** | `stage-deploy.ts` `bash -c` | **The metacharacter check does not close the config RCE path.** Disproved with `bash .ci/deploy.sh` and `BASH_ENV=./tools/x.sh bash -c :` — no forbidden character, both execute. It also guards the *weaker* path: `scripts/deploy-frontend.sh` is committed, unvalidated, and auto-armed on a ~60s cooldown. Commit access to a watched repo **is** code execution as the operator, by design. | Documented honestly (`504f1a8`). Kept as defence-in-depth. **The real fix is a scoped `AWS_PROFILE` for deploys — not done.** |
| **Accepted** | deploy env | Full `process.env` inheritance, AWS keys included. An allowlist that misses a `VITE_*` var ships a build with a feature silently disabled rather than failing — a known past failure mode. | Documented, by decision |
| **Accepted** | Discord relay | Success messages post commit subjects; channel is trusted. | No change, by decision |
| **Accepted** | soft S3 claims | Advisory by design (no conditional writes); CI and `deploy-frontend.sh` bypass them entirely. | Documented |

---

## Open

- **Scoped deploy credential.** The only thing that would actually bound the blast radius
  of the accepted RCE above. Deliberately deferred, not forgotten.
- **Git error/status strings reaching the TUI unsanitized.** `cherryPick`, `mergeFastForward`,
  `pushSha` etc. return raw git stderr, which can echo attacker-influenced text. Not
  sanitized at the parse boundary because several call sites pattern-match the raw string
  for control flow; belongs at the display surface in `app.ts`/`checks.ts`.
- **Branch/ref names** are not sanitized. Git's ref grammar forbids control bytes but not
  Unicode format/bidi characters. Narrow (needs branch creation, and these repos use fixed
  `main`/`stage`/`prod`), but real if an arbitrary ref name ever reaches the display.
- **`render.ts` `renderModal`'s `pad()`** still measures with `.length`. `trunc()` and the
  commit-list budgets are width-aware; the leftover-files modal is not.
- **`hasConflictMarkers`** uses `git diff --check`, so markers in already-staged files pass.
  Mitigated by the eslint/i18n re-verify and the patch-id check.
- **Output-drain bound.** A deploy or agent grandchild that calls `setsid()` escapes the
  process-group kill and holds the pipe open. Both paths now race a deadline so nothing
  wedges, but a wall-clock cap cannot distinguish "hung" from "slow but legitimate" — doing
  it properly needs per-chunk read-progress tracking.
- **`checkedShas` / `warnedBlocks` / `ui.newShas`** grow unbounded. Bytes per commit.

## Accepted residual risk

- A child that calls `setsid()` itself escapes the process-group kill. Neither `s5cmd` nor
  `aws` is known to; re-check if the deploy script changes.
- The SIGTERM→SIGKILL grace means up to one in-flight PUT may still land — bounded, where
  it used to be unbounded.
- Worktree and deploy claims are advisory. They prevent accidents between colleagues, not
  deliberate races, and `Ctrl-C` leaves a claim to age out through its stale window.

## Process note

A concurrent session committed `a34ec8b` with a broad `git add` while the heartbeat and
abort fixes were uncommitted in this shared worktree. Its message describes only a Discord
relay change but it carries 130 insertions of unrelated fix work. Nothing was lost and the
code is correct; the history simply misdescribes itself. Left alone — rewriting a pushed
commit in a tree several sessions share is not a unilateral call. The lesson is to commit
completed work promptly here rather than letting it sit in the tree.
