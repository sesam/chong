import path from "node:path";
import { c } from "../util";
import { findAgentBin } from "./agent";
import {
  AUTO_MAINT_EVERY_COMMITS,
  AUTO_MAINT_EVERY_MS,
  checkI18n,
  ensureShadow,
  INJECT_GRACE_MS,
  isAutoFix,
  reconcileLocalMain,
  type ShadowInfo,
  runFormatFix,
  runI18nFix,
  runLockfileFix,
  runMaintenance,
  scanCommitForUntranslated,
  shadowPathFor,
  tryAgentI18nFix,
} from "./checks";
import {
  formatClaimHolder,
  isClaimStale,
  readDeployClaim,
  type DeployClaim,
} from "./deploy-claim";
import { type WatchConfig, computePipeline, enrichCI, gapHotkeys, promote } from "./model";
import { type UIState, render } from "./render";
import {
  defaultProdDeployCmd,
  prodDeployedShaBucket,
  resolveLiveProdTip,
  resolveLiveStageTip,
  resolveStageDeployCmd,
  runLocalProdDeploy,
  runLocalStageDeploy,
  stageDeployedShaBucket,
} from "./stage-deploy";
import {
  acquireWorktreeClaim,
  formatWorktreeHolder,
  isWorktreeClaimActive,
  readWorktreeClaim,
  releaseWorktreeClaim,
  touchWorktreeClaim,
  WORKTREE_CLAIM_TOUCH_MS,
  type WorktreeClaim,
} from "./worktree-claim";
import type { Pipeline } from "./types";

const ALT_ON = "\x1b[?1049h\x1b[?25l"; // alt screen + hide cursor
const ALT_OFF = "\x1b[?25h\x1b[?1049l"; // show cursor + leave alt screen

/**
 * `autoInject` — master switch for `reconcileLocalMain` (both the fast-forward push and
 * the diverged cherry-pick+push path). Default true, matching the pre-existing
 * behaviour; `--no-auto-inject` (see `src/commands/watch.ts`) sets this false.
 */
export async function runWatch(
  cfg: WatchConfig,
  intervalMs: number,
  autoInject = true,
): Promise<void> {
  /** Stable for this watch process — deploy claims + worktree ownership share it. */
  const processId = crypto.randomUUID();
  const shadowPath = shadowPathFor(cfg.repoPath);

  // Crash net: Bun terminates the process on an unhandled rejection or uncaught
  // exception, and nothing upstream of this process restores the terminal or releases
  // the worktree claim for us. Without this, any unguarded rejection anywhere (an agent
  // call, a stray git failure) leaves the alt screen on — the terminal is unusable until
  // `reset` — and the claim file live for its full 20-minute stale window, blocking every
  // other watch on this repo. Installed first, before any async work, and superseding
  // whatever generic handler `src/index.ts` installed for non-watch commands, so exactly
  // one handler — this one, which knows how to tear down — runs for the rest of the
  // process's life.
  let crashHandled = false;
  function crashRecover(reason: unknown, source: string): void {
    if (crashHandled) return; // never double-release / double-restore
    crashHandled = true;
    try {
      releaseWorktreeClaim(shadowPath, processId);
    } catch {
      /* best-effort — process is going down regardless */
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    try {
      process.stdout.write(ALT_OFF);
    } catch {
      /* ignore */
    }
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`\nchong watch crashed (${source}): ${msg}`);
    process.exit(1);
  }
  process.removeAllListeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  process.on("unhandledRejection", (reason) => crashRecover(reason, "unhandledRejection"));
  process.on("uncaughtException", (err) => crashRecover(err, "uncaughtException"));

  let worktreeOwned = false;
  let foreignWorktreeClaim: WorktreeClaim | null = null;
  let lastWorktreeTouchAt = 0;
  /**
   * Set while `[o]` is waiting on a second keypress to confirm stealing a *live* foreign
   * worktree claim (names the claim we warned the operator about). Null the rest of the
   * time — the free/stale path never touches this and stays a single keypress.
   */
  let pendingWorktreeOverride: WorktreeClaim | null = null;
  /**
   * The holder we last told the operator about when skipping inject/reconcile. Unlike
   * auto-maintain (queued on a handful of triggers), reconcile is attempted on every
   * poll, so an unconditional notice would refill the notice list with the same line
   * every second. One notice per holder — repeated only if ownership changes hands.
   */
  let reconcileSkipNoticeFor: string | null = null;

  let pipeline: Pipeline | null = null;
  let baseline: Set<string> | null = null; // remote incoming shas at the moment watch started
  let localBaseline: Set<string> | null = null; // local branch shas at the moment watch started
  let refreshing = false;
  let lastFrame: string | null = null;
  const warnedBlocks = new Set<string>(); // "branch@sha" pairs already warned as blocked
  const checkedShas = new Set<string>(); // shas that have been through post-commit checks
  let checkQueue = Promise.resolve(); // serializes shadow work — prevents index.lock races
  let reconciling = false; // one inject-local-main pass at a time
  let i18nPausedUntil = 0; // epoch ms — skip post-commit i18n auto-fix while set
  let remoteCommitsSinceMaint = 0;
  let lastAutoMaintAt = 0;
  let startupMaintQueued = false;
  let stageDeployBlockedForTip: string | null = null;
  /** Cooldown: deploy this origin/main tip once `stageDeployAt` elapses. */
  let pendingStageDeploySha: string | null = null;
  let stageDeployAt: number | null = null; // epoch ms
  let stageDeploying = false;
  /** Soft claim held by another watch (polled from S3); pauses our auto-deploy. */
  let remoteStageClaim: DeployClaim | null = null;
  let remoteProdClaim: DeployClaim | null = null;
  /** Seconds to wait before retrying after we lost a soft claim race. */
  const CLAIM_RETRY_SEC = 30;
  const stageDeployCmd = resolveStageDeployCmd(cfg.repoPath, cfg.stageDeployCmd);
  const localStageDeploy = cfg.autoDeployStage && !!stageDeployCmd;
  // Null when this repo has no way to deploy prod locally. The prod prompt then falls back
  // to the original y/n push-the-branch, rather than offering a choice it cannot honour.
  const prodDeployCmd = defaultProdDeployCmd(cfg.repoPath);
  /** Local SHAs that must not be re-injected (partial cherry-pick / patch-id mismatch). */
  const injectBlockedShas = new Set<string>();
  /** Local tip when injectBlockedShas was last filled — clear blocks when tip moves. */
  let injectBlockedForLocalTip: string | null = null;
  const agentEnabled = cfg.agent && !!findAgentBin();

  function noteInjectBlocks(res: { blockShas?: string[]; localTip?: string }): void {
    const tip = res.localTip ?? null;
    if (tip && injectBlockedForLocalTip !== tip) {
      injectBlockedShas.clear();
      injectBlockedForLocalTip = tip;
    }
    if (!res.blockShas?.length) return;
    for (const sha of res.blockShas) injectBlockedShas.add(sha);
  }

  function injectOpts(localTip: string | null | undefined): {
    processId: string;
    agentResolve: boolean;
    skipShas: ReadonlySet<string>;
    autoInject: boolean;
  } {
    if (localTip && injectBlockedForLocalTip && injectBlockedForLocalTip !== localTip) {
      injectBlockedShas.clear();
      injectBlockedForLocalTip = null;
    }
    // `processId` so reconcile's diverged path resets main-shadow under *our* claim
    // rather than unclaimed — see ReconcileOpts.
    return { processId, agentResolve: agentEnabled, skipShas: injectBlockedShas, autoInject };
  }

  const ui: UIState = {
    selectedGap: 0,
    expanded: false,
    status: "",
    confirm: null,
    busy: false,
    newShas: new Set(),
    newLocalShas: new Set(),
    notices: [],
    modal: null,
    maintenance: null,
    stageDeploy: null,
    canDeployProdLocally: !!prodDeployCmd,
    worktreeOverride: null,
  };

  const write = (s: string) => process.stdout.write(s);

  function paint(force = false): void {
    const frame = pipeline
      ? render(pipeline, ui)
      : `${c.bold("chong watch")}\n\n  ${c.dim("loading…")}`;
    if (!force && frame === lastFrame) return;
    lastFrame = frame;
    // home, rewrite each line clearing trailing chars, then clear everything below
    const body = frame
      .split("\n")
      .map((l) => `${l}\x1b[K`)
      .join("\r\n");
    write(`\x1b[H${body}\r\n\x1b[0J`);
  }

  function addNotice(msg: string): void {
    ui.notices = [msg, ...ui.notices].slice(0, 5);
  }

  function tryTakeWorktree(force = false): boolean {
    const prev = readWorktreeClaim(shadowPath);
    const res = acquireWorktreeClaim(shadowPath, processId, { force });
    if (res.ok) {
      worktreeOwned = true;
      foreignWorktreeClaim = null;
      lastWorktreeTouchAt = Date.now();
      reconcileSkipNoticeFor = null;
      if (res.forced && prev && prev.id !== processId) {
        addNotice(c.yellow(`⚒ worktree claim forced — was ${formatWorktreeHolder(prev)}`));
      }
      return true;
    }
    worktreeOwned = false;
    foreignWorktreeClaim = res.claim;
    return false;
  }

  /** Shared tail of the `[o]` override — force-take and report, whether armed via a
   * confirmed prompt or (free/stale case) taken outright on the first keypress. */
  function finishWorktreeOverride(): void {
    if (tryTakeWorktree(true)) {
      addNotice(c.green("✓ worktree override taken — auto-maintain enabled"));
      ui.worktreeOverride = null;
      if (cfg.autoMaintain && pipeline) queueAutoMaintain("after worktree override");
    }
  }

  function maybeTouchWorktreeClaim(): void {
    // Runs off the 1s clock regardless of repo activity: liveness must not depend on
    // commits arriving. A quiet `main`, or a long deploy/maintain run with no new
    // commits, must not let the claim age out from under a process that is still here.
    if (!worktreeOwned) return;
    if (Date.now() - lastWorktreeTouchAt < WORKTREE_CLAIM_TOUCH_MS) return;
    if (touchWorktreeClaim(shadowPath, processId)) {
      lastWorktreeTouchAt = Date.now();
    } else {
      worktreeOwned = false;
      foreignWorktreeClaim = readWorktreeClaim(shadowPath);
      addNotice(c.yellow("⚠ lost worktree ownership — auto-maintain paused"));
    }
  }

  function shadowOpts(forceWorktree = false): { processId: string; forceWorktree?: boolean } {
    return { processId, ...(forceWorktree ? { forceWorktree: true } : {}) };
  }

  /** Shadow warnings already shown — they recur on every call until dealt with by hand. */
  const shownShadowWarnings = new Set<string>();

  /**
   * `ensureShadow` + reconcile our view of ownership with what its (mandatory) claim
   * acquire actually did.
   *
   * The acquire used to be swallowed inside `ensureShadow`, so a claim taken by, say,
   * the post-commit check pass never reached `worktreeOwned` here: the operator was
   * told "no worktree ownership" and every claim-gated action stayed off while this
   * process demonstrably held the claim. Going through this wrapper means the app's
   * view of ownership is whatever the filesystem last told us, in both directions.
   */
  async function ensureOwnedShadow(repoPath: string, ref: string): Promise<ShadowInfo> {
    const shadow = await ensureShadow(repoPath, ref, shadowOpts());
    if (shadow.claim.ok) {
      if (!worktreeOwned) addNotice(c.dim("worktree claim acquired during shadow work"));
      worktreeOwned = true;
      foreignWorktreeClaim = null;
      lastWorktreeTouchAt = Date.now();
      reconcileSkipNoticeFor = null;
    } else {
      worktreeOwned = false;
      foreignWorktreeClaim = shadow.claim.claim;
    }
    for (const w of shadow.warnings ?? []) {
      if (shownShadowWarnings.has(w)) continue;
      shownShadowWarnings.add(w);
      addNotice(c.yellow(`⚠ ${w}`));
    }
    return shadow;
  }

  function syncStageDeployUi(): void {
    if (!localStageDeploy) {
      ui.stageDeploy = null;
      return;
    }
    if (stageDeploying) {
      ui.stageDeploy = {
        kind: "deploying",
        shaShort: (pendingStageDeploySha ?? cfg.stageDeployedSha ?? "").slice(0, 7),
        secsLeft: 0,
        by: process.env.USER || "local",
      };
      return;
    }
    if (remoteStageClaim && !isClaimStale(remoteStageClaim)) {
      ui.stageDeploy = {
        kind: "remote-deploying",
        shaShort: remoteStageClaim.sha.slice(0, 7),
        secsLeft: 0,
        by: formatClaimHolder(remoteStageClaim),
      };
      return;
    }
    if (pendingStageDeploySha && stageDeployAt) {
      const secsLeft = Math.max(0, Math.ceil((stageDeployAt - Date.now()) / 1000));
      ui.stageDeploy = {
        kind: "countdown",
        shaShort: pendingStageDeploySha.slice(0, 7),
        secsLeft,
      };
      return;
    }
    if (cfg.stageDeployedSha) {
      ui.stageDeploy = {
        kind: "live",
        shaShort: cfg.stageDeployedSha.slice(0, 7),
        secsLeft: 0,
      };
      return;
    }
    ui.stageDeploy = { kind: "idle", shaShort: "", secsLeft: 0 };
  }

  /**
   * Arm / reset the stage-deploy cooldown whenever origin/main tip moves past
   * what's already live on app-ci. Additional commits reset the 60s window.
   */
  function armStageDeployCooldown(mainTip: string, reason: string): void {
    if (!localStageDeploy || !mainTip) return;
    if (cfg.stageDeployedSha && cfg.stageDeployedSha === mainTip) {
      pendingStageDeploySha = null;
      stageDeployAt = null;
      stageDeployBlockedForTip = null;
      syncStageDeployUi();
      return;
    }
    if (stageDeployBlockedForTip === mainTip) return;
    if (stageDeploying) return;
    // Another watch is mid-deploy — wait; refresh will re-arm when the claim clears.
    if (remoteStageClaim && !isClaimStale(remoteStageClaim)) {
      pendingStageDeploySha = null;
      stageDeployAt = null;
      syncStageDeployUi();
      return;
    }

    const reset = pendingStageDeploySha !== mainTip;
    pendingStageDeploySha = mainTip;
    stageDeployAt = Date.now() + cfg.deployCooldownSec * 1000;
    syncStageDeployUi();
    if (reset) {
      addNotice(
        c.dim(
          `stage deploy: cooldown ${cfg.deployCooldownSec}s for ${mainTip.slice(0, 7)} (${reason})`,
        ),
      );
    }
  }

  async function executeStageDeploy(reason: string): Promise<void> {
    if (!localStageDeploy || !pipeline || !stageDeployCmd || stageDeploying) return;
    const tip = pendingStageDeploySha ?? pipeline.lanes[0]?.tip;
    if (!tip) return;
    if (cfg.stageDeployedSha === tip) {
      pendingStageDeploySha = null;
      stageDeployAt = null;
      syncStageDeployUi();
      return;
    }

    stageDeploying = true;
    pendingStageDeploySha = tip;
    stageDeployAt = null;
    syncStageDeployUi();
    ui.status = c.yellow(`deploying stage ${tip.slice(0, 7)} (${reason})…`);
    paint();

    // Wrapped so a rejection anywhere in the deploy (agent call, git, upload) becomes a
    // notice instead of an unhandled rejection that would kill the whole watch process —
    // see the crash net installed at the top of runWatch.
    try {
      const mainBranch = pipeline.lanes[0]?.name ?? "main";
      const stageBranch = pipeline.lanes.find((l) => l.name === "stage")?.name ?? "stage";
      const res = await runLocalStageDeploy(
        pipeline.repoPath,
        pipeline.remote,
        mainBranch,
        stageBranch,
        stageDeployCmd,
        {
          agent: agentEnabled,
          importScan: cfg.importScan,
          processId,
          onProgress: (msg) => {
            addNotice(c.dim(msg));
            paint();
          },
        },
      );

      stageDeploying = false;
      if (res.action === "deployed" && res.sha) {
        cfg.stageDeployedSha = res.sha;
        pendingStageDeploySha = null;
        stageDeployAt = null;
        stageDeployBlockedForTip = null;
        remoteStageClaim = null;
        addNotice(c.green(`✓ ${res.message}`));
        ui.status = c.green(`✓ ${res.message}`);
        void refresh();
      } else if (res.action === "fixed") {
        // eslint landed on main — wait for the new tip, then re-arm cooldown
        pendingStageDeploySha = null;
        stageDeployAt = null;
        addNotice(c.green(`✓ ${res.message}`));
        void refresh();
      } else if (res.action === "noop") {
        if (res.sha) cfg.stageDeployedSha = res.sha;
        pendingStageDeploySha = null;
        stageDeployAt = null;
        addNotice(c.dim(res.message));
      } else if (res.action === "deferred") {
        // Soft claim held by someone else — retry soon; do NOT permanently block the tip.
        remoteStageClaim = res.claim ?? remoteStageClaim;
        pendingStageDeploySha = tip;
        stageDeployAt = Date.now() + CLAIM_RETRY_SEC * 1000;
        addNotice(c.yellow(`⏳ ${res.message} — retry in ${CLAIM_RETRY_SEC}s`));
        ui.status = c.yellow(`⏳ ${res.message}`);
      } else if (res.action === "blocked") {
        stageDeployBlockedForTip = tip;
        pendingStageDeploySha = null;
        stageDeployAt = null;
        addNotice(c.yellow(`⚠ stage: ${res.message}`));
        ui.status = c.yellow(`⚠ stage: ${res.message}`);
      } else {
        stageDeployBlockedForTip = tip;
        pendingStageDeploySha = null;
        stageDeployAt = null;
        addNotice(c.red(`✗ stage: ${res.message}`));
        ui.status = c.red(`✗ stage: ${res.message}`);
      }
    } catch (e) {
      stageDeploying = false;
      stageDeployBlockedForTip = tip;
      pendingStageDeploySha = null;
      stageDeployAt = null;
      const msg = e instanceof Error ? e.message : String(e);
      addNotice(c.red(`✗ stage deploy crashed: ${msg}`));
      ui.status = c.red(`✗ stage deploy crashed: ${msg}`);
    }
    syncStageDeployUi();
    paint();
  }

  /** Tick the countdown; fire deploy when it hits zero. */
  function tickStageDeployCooldown(): void {
    if (!localStageDeploy || stageDeploying) return;
    syncStageDeployUi();
    if (pendingStageDeploySha && stageDeployAt && Date.now() >= stageDeployAt) {
      const tip = pendingStageDeploySha;
      stageDeployAt = null; // consume so we don't re-queue every second
      const run = () => executeStageDeploy(`cooldown ${tip.slice(0, 7)}`);
      checkQueue = checkQueue.then(run, run);
    }
  }

  let maintaining = false;

  /**
   * Commit-producing maintain (deps / lockfile / format) — no TUI takeover.
   * Used on watch start, every 20 remote commits, and every 2h.
   */
  function queueAutoMaintain(reason: string): void {
    if (!cfg.autoMaintain || !pipeline || maintaining) return;
    if (!worktreeOwned) {
      addNotice(
        c.dim(
          foreignWorktreeClaim
            ? `maintain skipped — worktree owned by ${formatWorktreeHolder(foreignWorktreeClaim)} ([o] override)`
            : "maintain skipped — no worktree ownership",
        ),
      );
      return;
    }
    maintaining = true;
    remoteCommitsSinceMaint = 0;
    lastAutoMaintAt = Date.now();
    addNotice(c.dim(`maintain: auto (${reason})…`));
    paint();

    const run = async (): Promise<void> => {
      if (!pipeline) return;
      const { repoPath, remote, lanes } = pipeline;
      const headBranch = lanes[0].name;
      try {
        const injected = await reconcileLocalMain(
          repoPath,
          remote,
          headBranch,
          injectOpts(pipeline.localCommits[0]?.sha),
        );
        if (injected.action !== "noop") {
          noteInjectBlocks(injected);
          addNotice(
            injected.pushed
              ? c.green(`✓ inject: ${injected.message}`)
              : c.yellow(`⚠ inject: ${injected.message}`),
          );
          if (injected.action === "conflict" || injected.action === "error") {
            addNotice(c.yellow("⚠ auto-maintain skipped — inject failed"));
            return;
          }
        }
        const shadow = await ensureOwnedShadow(repoPath, `${remote}/${headBranch}`);
        if (shadow.error) {
          addNotice(c.red(`✗ auto-maintain shadow: ${shadow.error}`));
          return;
        }
        const res = await runMaintenance(
          repoPath,
          shadow.shadowPath,
          { format: cfg.formatCmd, test: cfg.testCmd, i18n: cfg.i18nCmd },
          remote,
          headBranch,
          (msg) => {
            addNotice(c.dim(`maintain: ${msg}`));
            paint();
          },
          { mode: "commits", agentI18n: agentEnabled },
        );
        for (const s of res.steps.slice(-3)) {
          addNotice(s.startsWith("✓") ? c.green(s) : s.startsWith("⚠") ? c.yellow(s) : c.dim(s));
        }
        addNotice(c.green(`✓ auto-maintain done (${reason})`));
        paint();
        if (pipeline?.lanes[0]?.tip) {
          armStageDeployCooldown(pipeline.lanes[0].tip, "after auto-maintain");
        }
        void refresh();
      } catch (e) {
        addNotice(c.red(`✗ auto-maintain: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        maintaining = false;
      }
    };
    checkQueue = checkQueue.then(run, run);
  }

  async function runCommitChecks(sha: string, src: "local" | "remote"): Promise<void> {
    if (!pipeline) return;
    // Wrapped so a rejection anywhere below (agent call, shadow git op) becomes a notice
    // instead of an unhandled rejection that would kill the whole watch process — see the
    // crash net installed at the top of runWatch.
    try {
      await runCommitChecksInner(sha, src);
    } catch (e) {
      addNotice(
        c.red(`✗ ${sha.slice(0, 7)} checks crashed: ${e instanceof Error ? e.message : String(e)}`),
      );
      paint();
    }
  }

  async function runCommitChecksInner(sha: string, src: "local" | "remote"): Promise<void> {
    if (!pipeline) return;
    if (await isAutoFix(pipeline.repoPath, sha)) return;

    const { repoPath, remote, lanes } = pipeline;
    const headBranch = lanes[0].name;

    // i18n mismatch flag
    const i18n = await checkI18n(repoPath, sha);
    if (i18n.mismatch) {
      addNotice(
        i18n.hasI18nCode
          ? c.yellow(`⚠ ${sha.slice(0, 7)}: i18n code change without .po/.pot update`)
          : c.yellow(`⚠ ${sha.slice(0, 7)}: .po/.pot changed without i18n code changes`),
      );
      paint();
    }

    // Hardcoded strings not wrapped in t() — cheap, diff-scoped, so run on every
    // new commit (local or remote). pnpm i18n can't catch these; this can.
    if (cfg.i18nScan) {
      const untrans = await scanCommitForUntranslated(repoPath, sha);
      if (untrans.length) {
        const total = untrans.reduce((s, u) => s + u.findings.length, 0);
        const where = untrans
          .slice(0, 2)
          .map((u) => path.basename(u.file))
          .join(", ");
        addNotice(
          c.yellow(
            `⚠ ${sha.slice(0, 7)}: ${total} hardcoded string(s) not wrapped in t() (${where}${untrans.length > 2 ? ", …" : ""}) — run [m]`,
          ),
        );
        paint();
      }
    }

    if (src !== "remote") return;

    const shadow = await ensureOwnedShadow(repoPath, `${remote}/${headBranch}`);
    if (shadow.error) {
      addNotice(c.red(`✗ shadow: ${shadow.error}`));
      paint();
      return;
    }

    // i18n auto-fix (paused for 2h after an uncertain agent i18n verdict)
    const i18nPaused = Date.now() < i18nPausedUntil;
    if (i18nPaused) {
      addNotice(
        c.dim(
          `⏸ ${sha.slice(0, 7)}: i18n auto-fix paused ${Math.ceil((i18nPausedUntil - Date.now()) / 60000)}m`,
        ),
      );
    } else {
      const i18nFix = await runI18nFix(repoPath, shadow.shadowPath, remote, headBranch);
      if (i18nFix.error) {
        addNotice(c.red(`✗ ${sha.slice(0, 7)} i18n: ${i18nFix.error.slice(0, 200)}`));
        // Empty msgstr / identical en·sl / other pnpm i18n failures → cursor-agent
        if (agentEnabled) {
          const out = i18nFix.failOutput ?? i18nFix.error;
          const summary = [
            `\`pnpm i18n\` failed on commit ${sha.slice(0, 7)} in the main-shadow worktree.`,
            "Fix empty msgstr / identical en·sl (allowlist when intentional) / other mechanical i18n failures until the command exits 0.",
            "",
            "Command output:",
            out.slice(0, 5000),
          ].join("\n");
          addNotice(c.dim(`… ${sha.slice(0, 7)}: asking coding agent to fix i18n…`));
          paint();
          const agentRes = await tryAgentI18nFix(
            repoPath,
            shadow.shadowPath,
            summary,
            cfg.i18nCmd,
            remote,
            headBranch,
          );
          addNotice(
            agentRes.fixed ? c.green(`✓ ${agentRes.message}`) : c.yellow(`⚠ ${agentRes.message}`),
          );
          if (agentRes.pauseUntil) i18nPausedUntil = agentRes.pauseUntil;
        }
      } else if (i18nFix.committed) {
        addNotice(c.green(`✓ ${sha.slice(0, 7)}: pnpm i18n applied → pushed to ${headBranch}`));
      }
      if (i18nFix.leftovers.length > 0) {
        if (agentEnabled) {
          const summary = [
            `After pnpm i18n on commit ${sha.slice(0, 7)}, these non-.po/.pot files changed:`,
            ...i18nFix.leftovers.map((f) => `  ${f}`),
          ].join("\n");
          const agentRes = await tryAgentI18nFix(
            repoPath,
            shadow.shadowPath,
            summary,
            cfg.i18nCmd,
            remote,
            headBranch,
          );
          addNotice(
            agentRes.fixed ? c.green(`✓ ${agentRes.message}`) : c.yellow(`⚠ ${agentRes.message}`),
          );
          if (agentRes.pauseUntil) i18nPausedUntil = agentRes.pauseUntil;
        } else if (!ui.modal) {
          ui.modal = {
            title: "Leftover changes after pnpm i18n",
            body: [
              `Commit: ${sha.slice(0, 7)}`,
              "",
              "These files changed but were not committed:",
              ...i18nFix.leftovers.map((f) => `  ${f}`),
            ],
          };
        }
      }
    }
    paint();

    // Lockfile fix: a package.json change without a matching lockfile update breaks
    // CI's --frozen-lockfile install. Regenerate pnpm-lock.yaml and push.
    const lockFix = await runLockfileFix(repoPath, shadow.shadowPath, sha, remote, headBranch);
    if (lockFix.error) {
      addNotice(c.red(`✗ ${sha.slice(0, 7)} lockfile: ${lockFix.error}`));
    } else if (lockFix.committed) {
      addNotice(c.green(`✓ ${sha.slice(0, 7)}: pnpm lockfile updated → pushed to ${headBranch}`));
    }
    paint();

    // Format fix
    const formatFix = await runFormatFix(
      repoPath,
      shadow.shadowPath,
      sha,
      cfg.formatCmd,
      remote,
      headBranch,
    );
    if (formatFix.error) {
      addNotice(c.red(`✗ ${sha.slice(0, 7)} format: ${formatFix.error}`));
    } else if (formatFix.committed) {
      addNotice(c.green(`✓ ${sha.slice(0, 7)}: formatting applied → pushed to ${headBranch}`));
    }
    paint();

    // Count remote commits toward auto-maintain (every N).
    if (cfg.autoMaintain) {
      remoteCommitsSinceMaint += 1;
      if (remoteCommitsSinceMaint >= AUTO_MAINT_EVERY_COMMITS) {
        queueAutoMaintain(`every ${AUTO_MAINT_EVERY_COMMITS} commits`);
      }
    }

    if (pipeline?.lanes[0]?.tip) {
      armStageDeployCooldown(pipeline.lanes[0].tip, "after post-commit checks");
    }
  }

  function noteReconcileSkipped(): void {
    const holderId = foreignWorktreeClaim?.id ?? "none";
    if (reconcileSkipNoticeFor === holderId) return;
    reconcileSkipNoticeFor = holderId;
    addNotice(
      c.dim(
        foreignWorktreeClaim
          ? `inject skipped — worktree owned by ${formatWorktreeHolder(foreignWorktreeClaim)} ([o] override)`
          : "inject skipped — no worktree ownership",
      ),
    );
  }

  /**
   * If local `main` (head lane) has commits origin lacks, land them via push or
   * cherry-pick onto main-shadow. Stage deploy cooldown is armed after inject.
   * Serialized on checkQueue so it never races i18n/format/maintain shadow work.
   * Fire-and-forget from refresh — does not block the poll loop.
   */
  function maybeReconcileLocalMain(): void {
    if (!pipeline || reconciling) return;
    const headBranch = pipeline.lanes[0]?.name;
    if (!headBranch) return;
    // Same gate as queueAutoMaintain, and for the same reason: reconcile's diverged
    // path resets main-shadow to the origin tip. This runs from refresh() on *every*
    // poll cycle, so without the gate a watch that does not own the worktree wiped it
    // the moment its local `main` diverged — mid-deploy or mid-agent-edit included.
    if (!worktreeOwned) {
      noteReconcileSkipped();
      return;
    }

    reconciling = true;
    const run = async (): Promise<void> => {
      try {
        if (!pipeline) return;
        const headTip = pipeline.localCommits[0]?.sha ?? null;
        const res = await reconcileLocalMain(
          pipeline.repoPath,
          pipeline.remote,
          headBranch,
          injectOpts(headTip),
        );
        if (res.action === "noop") return;
        noteInjectBlocks(res);
        if (res.action === "conflict" || res.action === "error" || res.action === "skipped") {
          addNotice(c.yellow(`⚠ ${res.message}`));
        } else {
          addNotice(c.green(`✓ ${res.message}`));
        }
        paint();
        if (res.pushed) {
          stageDeployBlockedForTip = null;
          void refresh();
          // cooldown armed from refresh once main tip is visible
        }
      } finally {
        reconciling = false;
      }
    };
    checkQueue = checkQueue.then(run, run);
  }

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    ui.busy = true;
    paint();

    // Prefer live S3 markers for lane tips when configured. Skip while a local stage
    // deploy is in flight so we do not rewind the tracker to a still-stale marker.
    if (localStageDeploy && !stageDeploying) {
      const live = await resolveLiveStageTip(cfg.repoPath);
      if (live.commit) cfg.stageDeployedSha = live.commit;
    }
    if (!stageDeploying) {
      const prodLive = await resolveLiveProdTip(cfg.repoPath);
      cfg.prodDeployedSha = prodLive.commit;
    }

    // Soft deploy claims — who (if anyone) is mid-upload on each bucket.
    const stageBucket = stageDeployedShaBucket(cfg.repoPath);
    const prodBucket = prodDeployedShaBucket(cfg.repoPath);
    const [stageClaim, prodClaim] = await Promise.all([
      stageBucket && !stageDeploying ? readDeployClaim(stageBucket) : Promise.resolve(null),
      prodBucket ? readDeployClaim(prodBucket) : Promise.resolve(null),
    ]);
    remoteStageClaim =
      stageClaim && !isClaimStale(stageClaim) && stageClaim.sha ? stageClaim : null;
    remoteProdClaim = prodClaim && !isClaimStale(prodClaim) && prodClaim.sha ? prodClaim : null;

    // If a foreign worktree claim went stale, try to take over quietly.
    if (!worktreeOwned) {
      const foreign = readWorktreeClaim(shadowPath);
      if (!foreign || !isWorktreeClaimActive(shadowPath)) {
        if (tryTakeWorktree(false)) {
          addNotice(c.green("✓ worktree claim acquired (previous owner stale)"));
        }
      } else {
        foreignWorktreeClaim = foreign;
      }
    }
    ui.worktreeOverride =
      !worktreeOwned && foreignWorktreeClaim
        ? formatWorktreeHolder(foreignWorktreeClaim)
        : null;

    if (remoteProdClaim) {
      // Surface once per claim id so the status line is not spammy every poll.
      const key = `prod-claim:${remoteProdClaim.id}`;
      if (!warnedBlocks.has(key)) {
        warnedBlocks.add(key);
        addNotice(
          c.yellow(`⏳ prod deploy in progress by ${formatClaimHolder(remoteProdClaim)}`),
        );
      }
    }
    syncStageDeployUi();

    const { pipeline: p, error, synced } = await computePipeline(cfg);

    // Report auto-fast-forwarded local refs. Successes are self-clearing (the ref
    // catches up to origin), so they don't repeat; blocked branches would re-report
    // every poll, so warn once per target sha.
    for (const s of synced) {
      if (s.ok) {
        addNotice(c.green(`⇡ ${s.branch}: fast-forwarded ${s.behind} commit(s) → ${s.toShort}`));
      } else if (s.blocked) {
        const key = `${s.branch}@${s.originSha}`;
        if (!warnedBlocks.has(key)) {
          warnedBlocks.add(key);
          addNotice(
            c.yellow(
              `⚠ ${s.branch}: ${s.behind} behind origin — local changes block auto fast-forward`,
            ),
          );
        }
      }
    }

    if (p) {
      if (baseline === null) {
        baseline = new Set(p.incoming.map((cm) => cm.sha));
        localBaseline = new Set(p.localCommits.map((cm) => cm.sha));
      } else {
        for (const cm of p.incoming) {
          if (!baseline.has(cm.sha)) {
            ui.newShas.add(cm.sha);
            if (!checkedShas.has(cm.sha)) {
              checkedShas.add(cm.sha);
              const sha = cm.sha;
              const run = () => runCommitChecks(sha, "remote");
              checkQueue = checkQueue.then(run, run);
            }
          }
        }
        for (const cm of p.localCommits) {
          if (!localBaseline!.has(cm.sha)) {
            ui.newLocalShas.add(cm.sha);
            if (!checkedShas.has(cm.sha)) {
              checkedShas.add(cm.sha);
              const sha = cm.sha;
              const run = () => runCommitChecks(sha, "local");
              checkQueue = checkQueue.then(run, run);
            }
          }
        }
      }
      pipeline = p;
      if (ui.selectedGap > p.gaps.length - 1) ui.selectedGap = Math.max(0, p.gaps.length - 1);
      ui.status = error ? c.yellow(`⚠ ${error}`) : ui.status;
      const mainTip = p.lanes[0]?.tip;
      if (localStageDeploy) {
        const stageLane = p.lanes.find((l) => l.name === "stage");
        if (stageLane?.tip) cfg.stageDeployedSha = stageLane.tip;
      }
      if (mainTip && stageDeployBlockedForTip && stageDeployBlockedForTip !== mainTip) {
        stageDeployBlockedForTip = null;
      }
      if (mainTip && localStageDeploy && baseline !== null) {
        armStageDeployCooldown(mainTip, "pipeline poll");
      }
      paint();
      // CI is slower / best-effort — fill it in and repaint when ready. `.catch` so a
      // failed CI lookup becomes a notice instead of an unhandled rejection.
      enrichCI(p)
        .then(() => {
          if (pipeline === p) paint();
        })
        .catch((e) => {
          addNotice(c.yellow(`⚠ CI enrich failed: ${e instanceof Error ? e.message : String(e)}`));
        });
    } else {
      ui.status = c.red(`✗ ${error ?? "could not read pipeline"}`);
    }
    ui.busy = false;
    refreshing = false;
    paint();

    // Queue a local→origin inject if needed (runs after any in-flight shadow work).
    if (pipeline) {
      maybeReconcileLocalMain();
    }
  }

  /** True when the pending confirmation is a prod gap that can ship locally as well as remotely. */
  function promptOffersProdRoute(idx: number): boolean {
    return !!prodDeployCmd && pipeline?.gaps[idx]?.to === "prod";
  }

  /**
   * `mode` only matters for prod, which can ship either way:
   *   "remote" — push the SHA onto `prod` and let GitHub Actions deploy it (the original)
   *   "local"  — build and upload from here, exactly as stage does
   *   "force"  — local deploy that overwrites another watch's soft claim
   * Stage is always local when a deploy command exists, so it ignores this.
   */
  async function doPromote(
    idx: number,
    mode: "remote" | "local" | "force" = "remote",
  ): Promise<void> {
    if (!pipeline) return;
    const gap = pipeline.gaps[idx];
    ui.confirm = null;

    if ((mode === "local" || mode === "force") && gap.to === "prod" && prodDeployCmd) {
      // Deploy the stage lane tip — the same commit a remote promote would have pushed,
      // so local and remote ship identical content.
      const stageTip = pipeline.lanes.find((l) => l.name === "stage")?.tip;
      if (!stageTip) {
        ui.status = c.red("✗ no stage tip to deploy to prod");
        paint();
        return;
      }
      if (remoteProdClaim && !isClaimStale(remoteProdClaim) && mode !== "force") {
        ui.status = c.yellow(
          `⏳ prod deploy already in progress by ${formatClaimHolder(remoteProdClaim)} — [f] to force`,
        );
        paint();
        return;
      }
      ui.busy = true;
      ui.status = c.yellow(
        `deploying ${stageTip.slice(0, 7)} → PRODUCTION (local${mode === "force" ? ", forced" : ""})…`,
      );
      paint();
      const res = await runLocalProdDeploy(cfg.repoPath, gap.to, stageTip, prodDeployCmd, {
        force: mode === "force",
        processId,
        onProgress: (m) => {
          ui.status = c.yellow(m);
          paint();
        },
      });
      if (res.action === "deferred" && res.claim) {
        remoteProdClaim = res.claim;
        ui.status = c.yellow(`⏳ ${res.message} — [f] to force`);
      } else if (res.action === "deployed") {
        remoteProdClaim = null;
        ui.status = c.green(`✓ ${res.message}`);
      } else if (res.action === "noop") {
        ui.status = c.dim(res.message);
      } else {
        ui.status = c.red(`✗ ${res.message}`);
      }
      ui.busy = false;
      await refresh();
      return;
    }

    // Local stage deploy: [s] confirms an immediate deploy of origin/main (no git push).
    if (localStageDeploy && gap.to === "stage") {
      const mainTip = pipeline.lanes[0]?.tip;
      if (!mainTip) {
        ui.status = c.red("✗ no main tip to deploy");
        paint();
        return;
      }
      pendingStageDeploySha = mainTip;
      stageDeployAt = null; // fire now
      stageDeployBlockedForTip = null;
      ui.busy = true;
      paint();
      await executeStageDeploy("manual [s]");
      ui.busy = false;
      paint();
      return;
    }

    // The confirm step for a diverged gap is itself the explicit merge consent,
    // so only then do we allow a (non-ff) merge commit.
    const allowMerge = !gap.ff;
    const how = gap.ff ? "fast-forward" : "merge";
    ui.busy = true;
    ui.status = c.yellow(`promoting ${gap.from} → ${gap.to} (${how})…`);
    paint();
    const err = await promote(pipeline, idx, allowMerge, {
      autoDeployStage: localStageDeploy,
    });
    ui.status = err ? c.red(`✗ ${err}`) : c.green(`✓ promoted ${gap.from} → ${gap.to} (${how})`);
    ui.busy = false;
    await refresh();
  }

  async function doMaintenance(): Promise<void> {
    if (!pipeline || maintaining) return;
    maintaining = true;
    ui.busy = true;
    ui.maintenance = { running: true, steps: [], prompts: [] };
    paint();

    // Serialize with the shadow-worktree checks so maintenance and an incoming
    // commit's auto-fix never touch main-shadow at the same time.
    const run = async (): Promise<void> => {
      if (!pipeline) return;
      const { repoPath, remote, lanes } = pipeline;
      const headBranch = lanes[0].name;
      try {
        // Land any local head-lane commits onto origin first so maintain starts
        // from a tip that already includes them (and origin doesn't go stale).
        const injected = await reconcileLocalMain(
          repoPath,
          remote,
          headBranch,
          injectOpts(pipeline.localCommits[0]?.sha),
        );
        if (injected.action !== "noop") {
          noteInjectBlocks(injected);
          ui.maintenance = {
            running: true,
            steps: [
              injected.pushed ? `✓ inject: ${injected.message}` : `⚠ inject: ${injected.message}`,
            ],
            prompts: [],
          };
          paint();
          if (injected.action === "conflict" || injected.action === "error") {
            ui.maintenance = {
              running: false,
              steps: [`✗ inject failed — fix before maintain: ${injected.message}`],
              prompts: [],
            };
            return;
          }
        }

        const shadow = await ensureOwnedShadow(repoPath, `${remote}/${headBranch}`);
        if (shadow.error) {
          ui.maintenance = { running: false, steps: [`✗ shadow: ${shadow.error}`], prompts: [] };
          return;
        }
        const res = await runMaintenance(
          repoPath,
          shadow.shadowPath,
          { format: cfg.formatCmd, test: cfg.testCmd, i18n: cfg.i18nCmd },
          remote,
          headBranch,
          (msg) => {
            ui.maintenance = {
              running: true,
              steps: [...(ui.maintenance?.steps ?? []), msg],
              prompts: ui.maintenance?.prompts ?? [],
            };
            paint();
          },
          { mode: "full", agentI18n: agentEnabled },
        );
        if (res.i18nPauseUntil) i18nPausedUntil = res.i18nPauseUntil;
        remoteCommitsSinceMaint = 0;
        lastAutoMaintAt = Date.now();
        ui.maintenance = { running: false, steps: res.steps, prompts: res.prompts };
      } catch (e) {
        ui.maintenance = {
          running: false,
          steps: [`✗ maintenance crashed: ${e instanceof Error ? e.message : String(e)}`],
          prompts: [],
        };
      }
    };
    checkQueue = checkQueue.then(run, run);
    await checkQueue;

    ui.busy = false;
    maintaining = false;
    paint();
    if (pipeline?.lanes[0]?.tip) {
      armStageDeployCooldown(pipeline.lanes[0].tip, "after maintain");
    }
  }

  // ── teardown plumbing
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const clock = setInterval(() => {
    // Avoid repainting while the maintenance screen is open: it prints copy prompts
    // and constant redraws break terminal mouse selection.
    tickStageDeployCooldown();
    maybeTouchWorktreeClaim();
    if (!ui.maintenance) paint();
  }, 1000); // keep "↻ Ns ago" + stage countdown fresh
  const poll = setInterval(() => void refresh(), intervalMs);
  const autoMaintTimer = cfg.autoMaintain
    ? setInterval(() => {
        if (Date.now() - lastAutoMaintAt >= AUTO_MAINT_EVERY_MS) {
          queueAutoMaintain("every 2h");
        }
      }, 60_000)
    : null;

  function quit(): void {
    // Release worktree ownership first so another watch can take over immediately.
    releaseWorktreeClaim(shadowPath, processId);
    clearInterval(clock);
    clearInterval(poll);
    if (autoMaintTimer) clearInterval(autoMaintTimer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    write(ALT_OFF);
    resolve();
  }

  function onKey(s: string): void {
    if (ui.modal) {
      ui.modal = null;
      paint();
      return;
    }
    if (ui.maintenance) {
      // On the maintenance screen, `q` is NOT bound to quit — esc/n exit the
      // screen and we don't want `q` to be confused with that. Ctrl+C still quits.
      if (s === "\x03") {
        quit();
        return;
      }
      if (ui.maintenance.running) return; // ignore input mid-run (except quit)
      if (s === "m") {
        void doMaintenance();
        return;
      }
      if (s === "\x1b" || s === "n") {
        ui.maintenance = null;
        paint();
      }
      return;
    }
    if (!pipeline) {
      if (s === "q" || s === "\x03") quit();
      return;
    }

    // Any key that will not resolve the worktree-override prompt cancels it — it must
    // never sit there waiting to be accidentally confirmed by an unrelated keypress.
    // Falls through so that key still does its own normal thing (e.g. `o` re-arms fresh
    // against current state, `n`/esc is a no-op on top of this).
    //
    // `y` only reaches the override when no gap-promote confirm is open: that case is
    // handled first and returns. So a `y` with `ui.confirm` set promotes the gap and
    // would otherwise leave this armed but invisible — `ui.status` having been replaced
    // by the prod-route prompt — and the operator's *next* `y` would silently steal a
    // live claim they were never re-warned about. Treat that `y` as a cancel too.
    if (pendingWorktreeOverride && !(s === "y" && ui.confirm === null)) {
      pendingWorktreeOverride = null;
      ui.status = "";
    }

    const maxGap = pipeline.gaps.length - 1;

    // dedicated promote/deploy hotkey per gap (e.g. "s" → stage, "p" → prod)
    const gi = gapHotkeys(pipeline.gaps).indexOf(s);
    if (gi >= 0) {
      const gap = pipeline.gaps[gi];
      ui.selectedGap = gi;
      if (gap.ahead > 0) ui.confirm = gi;
      else {
        ui.confirm = null;
        ui.status = c.dim(
          localStageDeploy && gap.to === "stage"
            ? `${gap.from} → stage: already deployed`
            : `${gap.from} → ${gap.to}: nothing to promote`,
        );
      }
      paint();
      return;
    }

    switch (s) {
      case "q":
      case "\x03": // ctrl-c
        quit();
        return;
      case "\x1b[A": // up
      case "k":
        ui.selectedGap = Math.max(0, ui.selectedGap - 1);
        ui.confirm = null;
        break;
      case "\x1b[B": // down
      case "j":
        ui.selectedGap = Math.min(maxGap, ui.selectedGap + 1);
        ui.confirm = null;
        break;
      case " ":
        ui.expanded = !ui.expanded;
        break;
      case "y":
        if (ui.confirm !== null) {
          // A prod gap offering both routes has no sane default — "y" would silently pick
          // one of two very different actions, so make the operator name it.
          if (promptOffersProdRoute(ui.confirm)) {
            ui.status = c.yellow(
              "prod: [r] remote (GHA)  [l] local  [f] force local (override soft claim)",
            );
            break;
          }
          void doPromote(ui.confirm);
          return;
        }
        if (pendingWorktreeOverride) {
          const armed = pendingWorktreeOverride;
          pendingWorktreeOverride = null;
          ui.status = "";
          if (!isWorktreeClaimActive(shadowPath)) {
            // Went stale, or was released, while we waited on the confirm — nothing
            // live left to steal from.
            finishWorktreeOverride();
          } else {
            const current = readWorktreeClaim(shadowPath);
            if (current && current.id !== armed.id) {
              // A different process holds it now than when we warned the operator —
              // don't silently steal from someone we never named; re-arm against them.
              pendingWorktreeOverride = current;
              ui.status = c.yellow(
                `⚠ ${formatWorktreeHolder(current)} now holds the live claim — [y] steal it anyway  [n] cancel`,
              );
            } else {
              finishWorktreeOverride();
            }
          }
          paint();
          return;
        }
        break;
      // `r` is the CI-refresh key globally; while a prod prompt is open it means
      // "remote". Both live in this one case — a second `case "r"` below would be
      // unreachable and would silently kill CI refresh.
      case "r":
        if (ui.confirm !== null && promptOffersProdRoute(ui.confirm)) {
          void doPromote(ui.confirm, "remote");
          return;
        }
        // `paint` takes an optional `force`, so passing it directly makes the resolved
        // value the argument — wrap it. `.catch` so a failed CI lookup surfaces as a
        // notice instead of an unhandled rejection.
        if (pipeline) {
          void enrichCI(pipeline)
            .then(() => paint())
            .catch((e) => {
              addNotice(
                c.yellow(`⚠ CI refresh failed: ${e instanceof Error ? e.message : String(e)}`),
              );
              paint();
            });
        }
        break;
      case "l":
        if (ui.confirm !== null && promptOffersProdRoute(ui.confirm)) {
          void doPromote(ui.confirm, "local");
          return;
        }
        break;
      case "n":
      case "\x1b": // esc
        ui.confirm = null;
        break;
      case "m":
        void doMaintenance();
        return;
      case "f":
        // During a prod confirm, [f] force-deploys locally past a soft claim.
        // Otherwise [f] refreshes the pipeline (historical binding).
        if (ui.confirm !== null && promptOffersProdRoute(ui.confirm)) {
          void doPromote(ui.confirm, "force");
          return;
        }
        void refresh();
        return;
      case "o":
        // Override a foreign worktree claim — only meaningful when we do not own it.
        if (!worktreeOwned && foreignWorktreeClaim) {
          if (!isWorktreeClaimActive(shadowPath)) {
            // Free or stale — no live owner to steal from, so act immediately exactly
            // as before: no extra keypress in the common case.
            finishWorktreeOverride();
            paint();
            return;
          }
          // A live claim: don't take it on a single keypress — name whose claim it is
          // and wait for a confirming [y] (any other key cancels, see above).
          pendingWorktreeOverride = readWorktreeClaim(shadowPath) ?? foreignWorktreeClaim;
          ui.status = c.yellow(
            `⚠ ${formatWorktreeHolder(pendingWorktreeOverride)} has a live worktree claim — [y] steal it anyway  [n] cancel`,
          );
          paint();
          return;
        }
        break;
    }
    paint();
  }

  // ── go
  if (!process.stdin.isTTY) {
    throw new Error("chong watch needs an interactive terminal (TTY)");
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onKey);
  process.stdout.on("resize", paint);
  process.on("SIGINT", quit);

  write(ALT_ON);
  paint(true);

  // Claim the shared main-shadow worktree before any shadow work / auto-maintain.
  if (!tryTakeWorktree(false)) {
    addNotice(
      c.yellow(
        `⚠ worktree in use by ${formatWorktreeHolder(foreignWorktreeClaim!)} — auto-maintain off  [o] override`,
      ),
    );
  } else {
    addNotice(c.dim(`worktree claimed (${processId.slice(0, 8)}…)`));
  }

  addNotice(
    autoInject
      ? c.dim(`auto-inject: on (${Math.round(INJECT_GRACE_MS / 1000)}s grace before push)`)
      : c.yellow("⚠ auto-inject off (--no-auto-inject) — local commits are never auto-pushed"),
  );

  // Seed virtual stage / prod tips from live S3 markers (fallback: local branch / file)
  // before the first pipeline paint.
  if (localStageDeploy) {
    const live = await resolveLiveStageTip(cfg.repoPath);
    cfg.stageDeployedSha = live.commit;
    if (cfg.stageDeployedSha) {
      const via =
        live.source === "s3"
          ? "live S3 marker"
          : live.source === "local-branch"
            ? "local stage branch"
            : "local backup file";
      addNotice(c.dim(`stage live @ ${cfg.stageDeployedSha.slice(0, 7)} (${via})`));
    } else {
      addNotice(
        c.dim("stage deploy: no local stage tip yet — first cooldown will ship origin/main"),
      );
    }
    syncStageDeployUi();
  } else if (cfg.autoDeployStage && !stageDeployCmd) {
    addNotice(
      c.yellow(
        "⚠ auto stage deploy on, but no scripts/deploy-frontend.sh — pass --stage-deploy-cmd",
      ),
    );
  }

  {
    const prodLive = await resolveLiveProdTip(cfg.repoPath);
    cfg.prodDeployedSha = prodLive.commit;
    if (cfg.prodDeployedSha) {
      addNotice(c.dim(`prod live @ ${cfg.prodDeployedSha.slice(0, 7)} (live S3 marker)`));
    }
  }

  await refresh();
  if (cfg.autoMaintain && pipeline && !startupMaintQueued && worktreeOwned) {
    startupMaintQueued = true;
    queueAutoMaintain("on start");
  }
  if (cfg.agent && !findAgentBin()) {
    addNotice(
      c.yellow("⚠ no agent on PATH — install mcpify-agent (mcp-ify/offline-agent) or cursor-agent"),
    );
    paint();
  } else if (agentEnabled) {
    const label = Bun.which("mcpify-agent") ? "mcpify-agent (offline)" : "cursor-agent Auto";
    addNotice(c.dim(`agent: ${label} enabled (conflicts + i18n)`));
    paint();
  }
  await done;
}
