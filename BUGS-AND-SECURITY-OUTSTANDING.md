# Bugs and security — outstanding

Review of chong `HEAD~10..HEAD` at `1f11e76` (watch deploy claims, worktree ownership, live
S3 markers, local stage/prod deploy).

**Status 2026-09-11:** all seven correctness defects fixed, plus three more found during
the fix pass. Security items resolved per owner decision (see *Decisions*).
`bun test src/watch/` → **167 pass / 0 fail**; `bunx tsc --noEmit` clean (exit 0, was 1
error); `bun build --compile` succeeds. Nothing committed or staged.

---

## Bugs / correctness

| Severity | Location | Finding | Status |
|----------|----------|---------|--------|
| High | `worktree-claim.ts` (touch interval), `app.ts` (`maybeTouchWorktreeClaim`) | Owner mtime refreshed only when commits arrive. A quiet `main` (or a deploy >20m with no new commits) lets the claim go stale; another watch acquires + `ensureShadow` → `reset --hard` the shared shadow **while the first is still uploading**. | **FIXED** — touch is now purely time-based whenever `worktreeOwned`; the `commitsSinceWorktreeTouch` gate is gone. Liveness no longer depends on repo activity. |
| High | `worktree-claim.ts:22-24` | **Found during the fix pass, not in the original review.** `WORKTREE_CLAIM_TOUCH_MS === WORKTREE_CLAIM_STALE_MS` (both 20m) — the touch fired only at the exact moment the claim was already stale, so any jitter, slow S3 call or busy event loop made a live owner briefly look abandoned. Zero safety margin. | **FIXED** — stale window stays 20m (takeover speed unchanged); touch is now `STALE_MS / 3` (~6m40s), derived from it so the two cannot drift apart again. |
| High | `stage-deploy.ts` (`runDeployCommand` → `proc.kill()`) | Claim-loss abort killed only the `bash -c` parent. `s5cmd` / `aws` children survive and keep writing to the bucket after chong reports the deploy aborted — potentially after another watch has started its own upload. | **FIXED** — `Bun.spawn` with `detached: true` (POSIX `setsid`), abort signals the group via `process.kill(-pid, "SIGTERM")` and escalates to `SIGKILL` after a 5s grace. |
| Medium | `deploy-claim.ts` (`acquireDeployClaim` force path) | `force` wrote the claim and returned success **without** the read-back the normal path uses. A concurrent writer landing between write and deploy start left the forcer proceeding on a claim that named someone else. | **FIXED** — force now mirrors the normal verify read-back and returns the same `reason: "verify"` failure shape, so existing caller handling covers it. |
| Medium | `worktree-claim.ts` (`acquireWorktreeClaim`) | Acquire was check-then-write with no exclusive create. Two processes both seeing "absent/stale" both won; last writer owned the file while both mutated the worktree. | **FIXED** — exclusive create (`flag: "wx"` / `O_EXCL`), re-read on `EEXIST`, compare-and-swap on `at` before a stale takeover, write-then-verify read-back, bounded retries. |
| Medium | `app.ts` (`[o]` worktree override) | Single keypress, no confirm — easy to steal a live teammate's shadow by accident. | **FIXED** — `[o]` still acts in one keypress when the worktree is free or the claim is stale; it arms a `[y]`/`[n]` prompt naming the holder only when the claim is live. Liveness is re-checked at confirm time, and if a *different* process took it meanwhile the prompt re-arms against them rather than stealing silently. |
| Medium | `app.ts` (`[o]` confirm gate, cancel guard) | **Found while reviewing the fix above.** The cancel guard released the armed override on any key `!== "y"`, but `case "y"` resolves a gap-promote confirm first and returns. So pressing `y` with a prod confirm open promoted the gap, overwrote `ui.status` with the prod-route prompt, and left the override **armed but invisible** — the operator's next `y` would steal a live claim they were never re-warned about. | **FIXED** — the guard now cancels unless the key is a `y` that will actually reach the override (`ui.confirm === null`). |
| Low | `deploy-claim.ts` (`releaseDeployClaim`) | "Clear claim" wrote an empty object instead of deleting the key. Harmless (readers parse empty as absent) but a confusing tombstone that relied on that parse behaviour holding. | **FIXED** — deletes the key via `aws s3 rm`; verified `readDeployClaim` is the only reader and returns `null` for a missing key, so no reader change was needed. |
| Low | `stage-deploy.ts` (`startClaimHeartbeat`) | Async `setInterval` with no overlap guard; slow S3 stacked ticks, which could run out of order and race claim release. | **FIXED** — in-flight guard serializes ticks; existing `finally { stopHeartbeat() }` already covered every exit path. |
| Low | `stage-deploy.ts:454` | **Found during the fix pass.** The repo's only `tsc` error (TS2339) was a real operator-facing bug: the fallthrough built `` `deploy claim write failed: ${acquired.error}` `` while the union still included `{ reason: "no-bucket" }`, which has no `error` — so a repo that simply had no marker bucket configured was told `deploy claim write failed: undefined`. | **FIXED** — explicit `no-bucket` branch narrows the union and now reads `no stageDeployedShaBucket configured in .chong/config.json — cannot claim a stage deploy marker bucket`. |

---

## Security

| Severity | Location | Finding | Status |
|----------|----------|---------|--------|
| Medium | `stage-deploy.ts` (`bash -c` + `loadRepoDeployConfig`) | `deployCmd` can come from `.chong/config.json`, which is **deliberately committed** (`.chong/*` + `!.chong/config.json`). So anyone who can land a commit in a watched repo — or any supply-chain compromise of it — gets RCE as the operator, with full env. | **FIXED** — `stageDeployCmd` / `prodDeployCmd` read from repo config are refused if they contain a shell metacharacter (semicolon, pipe, ampersand, dollar, backtick, parentheses, angle brackets) or a newline; the repo then falls back to "no local deploy command", never to a silently-altered command. Free in practice: no repo sets it today (FRONTEND omits it on purpose and relies on script auto-detection). Scope checked: `packageJson*Deploy` return fixed literals gated on a script *key*, so no repo text reaches them; `resolveStageDeployCmd`'s bypass is fed only by the operator's own `--stage-deploy-cmd` flag (verified at `src/commands/watch.ts:55`), and its empty path falls through to the validated resolver. |
| Medium | `stage-deploy.ts` (`runDeployCommand` env) | Deploy inherits full `process.env` (AWS keys, tokens) into the shadow build. Any script compromise in the worktree exfiltrates the laptop's creds. | **DOCUMENTED, by decision** — see *Decisions*. New README §"Deploy trust boundary". |
| Medium | `deploy-claim.ts` / `worktree-claim.ts` (holder display) | Claim `user` / `host` came from S3 / on-disk JSON with light validation and went straight into TUI output. Anyone with marker-bucket write access could inject ANSI/control chars to corrupt or **spoof** the displayed claim holder. | **FIXED** — sanitized in both *parse* functions (not just the formatters), so every consumer benefits: CSI sequences stripped, then all remaining control bytes, then length-capped. Confirmed ownership comparisons key off the process `id`, never a sanitized field. |
| Low | `stage-deploy.ts` (`notifyDiscordStage`) | Success messages post commit subjects to a shared relay, so local deploys can leak unreleased commit text. | **NO CHANGE, by decision** — channel is trusted. |
| Info | Soft S3 claims (`deploy-claim.ts`) | Claims are advisory (no conditional writes). Anyone with bucket write can force or spoof; CI / `deploy-frontend.sh` bypass claims entirely. | **BY DESIGN** — now stated in the README rather than left implicit. |

---

## Decisions (owner, 2026-09-11)

1. **`deployCmd` RCE** — reject shell metacharacters in *configured* commands; keep `bash -c`
   and the built-in auto-detected defaults unchanged. Chosen over a full argv/allowlist
   rewrite because that would have to re-express the live default
   (`CI=true FORCE=1 DEPLOY_SKIP_INSTALL=1 ./scripts/deploy-frontend.sh ci`) and carries
   regression risk on the real deploy path, for no gain today.
2. **Deploy env** — keep full `process.env` inheritance; document it. An allowlist that
   misses a `VITE_*` var does not fail loudly, it ships a build with a feature silently
   disabled — a known past failure mode in this repo.
3. **`[o]` override** — confirm only when it would take a *live* claim. Free or stale
   worktree still overrides in one keypress, so the common case loses no convenience.
4. **Discord** — leave commit subjects in place; that channel is trusted.

## Already in good shape (for this window)

- Per-process UUID (no same-user self-collision on deploy claims)
- `.env` only (not `.env.local`) copied into the shadow for deploys
- Claim release only if still owner; worktree owner file beside the worktree (survives `git clean -fd`)
- Discord on success only (failures stay local)
- Bucket names opt-in via per-repo `.chong/config.json` (no cross-repo hardcoding)

## Residual risk, accepted

- A deploy child that calls `setsid()` itself would escape the process-group kill. Neither
  `s5cmd` nor `aws` is known to; worth re-checking if the deploy script changes.
- The 5s SIGTERM→SIGKILL grace assumes uploaders exit promptly on SIGTERM. Up to one
  in-flight PUT may still land — a bounded window where it used to be unbounded.
- Commit access to a watched repo remains a trust relationship; the metacharacter check
  narrows the blast radius, it does not remove it.
