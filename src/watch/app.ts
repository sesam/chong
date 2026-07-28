import path from "node:path";
import { c } from "../util";
import { findAgentBin } from "./agent";
import {
  AUTO_MAINT_EVERY_COMMITS,
  AUTO_MAINT_EVERY_MS,
  checkI18n,
  ensureShadow,
  isAutoFix,
  reconcileLocalMain,
  runFormatFix,
  runI18nFix,
  runLockfileFix,
  runMaintenance,
  scanCommitForUntranslated,
  tryAgentI18nFix,
} from "./checks";
import { type WatchConfig, computePipeline, enrichCI, gapHotkeys, promote } from "./model";
import { type UIState, render } from "./render";
import type { Pipeline } from "./types";

const ALT_ON = "\x1b[?1049h\x1b[?25l"; // alt screen + hide cursor
const ALT_OFF = "\x1b[?25h\x1b[?1049l"; // show cursor + leave alt screen

export async function runWatch(cfg: WatchConfig, intervalMs: number): Promise<void> {
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
  const agentEnabled = cfg.agent && !!findAgentBin();

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

  let maintaining = false;

  /**
   * Commit-producing maintain (deps / lockfile / format) — no TUI takeover.
   * Used on watch start, every 20 remote commits, and every 2h.
   */
  function queueAutoMaintain(reason: string): void {
    if (!cfg.autoMaintain || !pipeline || maintaining) return;
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
        const injected = await reconcileLocalMain(repoPath, remote, headBranch, {
          agentResolve: agentEnabled,
        });
        if (injected.action !== "noop") {
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
        const shadow = await ensureShadow(repoPath, `${remote}/${headBranch}`);
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

    const shadow = await ensureShadow(repoPath, `${remote}/${headBranch}`);
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
        addNotice(c.red(`✗ ${sha.slice(0, 7)} i18n: ${i18nFix.error}`));
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
  }

  /**
   * If local `main` (head lane) has commits origin lacks, land them via push or
   * cherry-pick onto main-shadow, then optionally FF the next lane (stage).
   * Serialized on checkQueue so it never races i18n/format/maintain shadow work.
   * Fire-and-forget from refresh — does not block the poll loop.
   */
  function maybeReconcileLocalMain(): void {
    if (!pipeline || reconciling) return;
    const headBranch = pipeline.lanes[0]?.name;
    if (!headBranch) return;

    reconciling = true;
    const run = async (): Promise<void> => {
      try {
        if (!pipeline) return;
        const res = await reconcileLocalMain(pipeline.repoPath, pipeline.remote, headBranch, {
          agentResolve: agentEnabled,
        });
        if (res.action === "noop") return;
        if (res.action === "conflict" || res.action === "error" || res.action === "skipped") {
          addNotice(c.yellow(`⚠ ${res.message}`));
        } else {
          addNotice(c.green(`✓ ${res.message}`));
        }
        paint();
        if (res.pushed) void refresh();
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
              checkQueue = checkQueue.then(() => runCommitChecks(sha, "remote"));
            }
          }
        }
        for (const cm of p.localCommits) {
          if (!localBaseline!.has(cm.sha)) {
            ui.newLocalShas.add(cm.sha);
            if (!checkedShas.has(cm.sha)) {
              checkedShas.add(cm.sha);
              const sha = cm.sha;
              checkQueue = checkQueue.then(() => runCommitChecks(sha, "local"));
            }
          }
        }
      }
      pipeline = p;
      if (ui.selectedGap > p.gaps.length - 1) ui.selectedGap = Math.max(0, p.gaps.length - 1);
      ui.status = error ? c.yellow(`⚠ ${error}`) : ui.status;
      paint();
      // CI is slower / best-effort — fill it in and repaint when ready
      enrichCI(p).then(() => {
        if (pipeline === p) paint();
      });
    } else {
      ui.status = c.red(`✗ ${error ?? "could not read pipeline"}`);
    }
    ui.busy = false;
    refreshing = false;
    paint();

    // Queue a local→origin inject if needed (runs after any in-flight shadow work).
    if (pipeline) maybeReconcileLocalMain();
  }

  async function doPromote(idx: number): Promise<void> {
    if (!pipeline) return;
    const gap = pipeline.gaps[idx];
    // The confirm step for a diverged gap is itself the explicit merge consent,
    // so only then do we allow a (non-ff) merge commit.
    const allowMerge = !gap.ff;
    const how = gap.ff ? "fast-forward" : "merge";
    ui.confirm = null;
    ui.busy = true;
    ui.status = c.yellow(`promoting ${gap.from} → ${gap.to} (${how})…`);
    paint();
    const err = await promote(pipeline, idx, allowMerge);
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
        const injected = await reconcileLocalMain(repoPath, remote, headBranch, {
          agentResolve: agentEnabled,
        });
        if (injected.action !== "noop") {
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

        const shadow = await ensureShadow(repoPath, `${remote}/${headBranch}`);
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
  }

  // ── teardown plumbing
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const clock = setInterval(() => {
    // Avoid repainting while the maintenance screen is open: it prints copy prompts
    // and constant redraws break terminal mouse selection.
    if (!ui.maintenance) paint();
  }, 1000); // keep "↻ Ns ago" fresh
  const poll = setInterval(() => void refresh(), intervalMs);
  const autoMaintTimer = cfg.autoMaintain
    ? setInterval(() => {
        if (Date.now() - lastAutoMaintAt >= AUTO_MAINT_EVERY_MS) {
          queueAutoMaintain("every 2h");
        }
      }, 60_000)
    : null;

  function quit(): void {
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
    const maxGap = pipeline.gaps.length - 1;

    // dedicated promote hotkey per gap (e.g. "s" → main→stage, "p" → stage→prod)
    const gi = gapHotkeys(pipeline.gaps).indexOf(s);
    if (gi >= 0) {
      const gap = pipeline.gaps[gi];
      ui.selectedGap = gi;
      if (gap.ahead > 0) ui.confirm = gi;
      else {
        ui.confirm = null;
        ui.status = c.dim(`${gap.from} → ${gap.to}: nothing to promote`);
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
          void doPromote(ui.confirm);
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
        void refresh();
        return;
      case "r":
        if (pipeline) void enrichCI(pipeline).then(paint);
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
  await refresh();
  if (cfg.autoMaintain && pipeline && !startupMaintQueued) {
    startupMaintQueued = true;
    queueAutoMaintain("on start");
  }
  if (cfg.agent && !findAgentBin()) {
    addNotice(
      c.yellow(
        "⚠ no agent on PATH — install mcpify-agent (mcp-ify/offline-agent) or cursor-agent",
      ),
    );
    paint();
  } else if (agentEnabled) {
    const label = Bun.which("mcpify-agent")
      ? "mcpify-agent (offline)"
      : "cursor-agent Auto";
    addNotice(c.dim(`agent: ${label} enabled (conflicts + i18n)`));
    paint();
  }
  await done;
}
