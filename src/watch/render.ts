import { c } from "../util";
import { gapHotkeys } from "./model";
import type { CIState, Gap, Lane, Pipeline } from "./types";

const mag = (s: string) => `\x1b[35m${s}\x1b[0m`;
const inverse = (s: string) => `\x1b[7m${s}\x1b[0m`;

export type UIState = {
  selectedGap: number; // index into pipeline.gaps
  expanded: boolean; // show the queued-commit list for the selected gap
  status: string; // transient status / result line
  confirm: number | null; // gap index awaiting y/n confirmation
  busy: boolean; // a promote/fetch is in flight
  newShas: Set<string>; // remote head-lane commits first seen since watch started
  newLocalShas: Set<string>; // local branch commits first seen since watch started
  notices: string[]; // recent check results, newest first (max 5 shown)
  modal: { title: string; body: string[] } | null; // leftover-files alert
};

const cols = () => process.stdout.columns || 100;

function trunc(s: string, n: number): string {
  if (n <= 1) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function ciBadge(ci: CIState): string {
  switch (ci) {
    case "pass":
      return c.green("✓ ci ");
    case "fail":
      return c.red("✗ ci ");
    case "pending":
      return c.yellow("● ci ");
    case "none":
      return c.dim("· ci ");
    default:
      return c.dim("? ci ");
  }
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function laneRow(lane: Lane): string {
  const subj = lane.commit?.subject ?? "(no commits)";
  const meta = lane.commit ? `${lane.commit.rel} ${lane.commit.author}` : "";
  const left = `  ${mag("●")} ${c.bold(lane.name.padEnd(7))} ${ciBadge(lane.ci)} ${c.yellow(lane.short)}  `;
  // budget the subject so the meta tail fits on the right
  const budget = cols() - 2 - 2 - 8 - 6 - 9 - meta.length - 3;
  return `${left}${trunc(subj, Math.max(10, budget))}  ${c.dim(meta)}`;
}

function gapRows(gap: Gap, key: string, selected: boolean, confirming: boolean): string[] {
  const how = gap.ff ? "fast-forward" : "merge";
  const drift = gap.behind > 0 ? c.red(`  ⚠ ${gap.behind} behind (drift)`) : "";

  let body: string;
  if (confirming) {
    body = gap.ff
      ? c.bold(
          c.yellow(
            `▸ fast-forward ${gap.ahead} commit(s)  ${gap.from} → ${gap.to}?  [y] yes  [n] no`,
          ),
        )
      : c.bold(
          c.red(
            `⚠ NOT a fast-forward — ${gap.to} has ${gap.behind} commit(s) ${gap.from} lacks.  Create a MERGE commit?  [y] merge  [n] cancel`,
          ),
        );
  } else if (gap.ahead === 0) {
    body = c.dim(`✓ ${gap.to} is up to date with ${gap.from}`) + drift;
  } else {
    const action = c.cyan(`[${key}] promote`);
    body = `${c.bold(`${gap.ahead}`)} queued for ${gap.to}   ${action} → ${gap.to} ${c.dim(`(${how})`)}${drift}`;
  }

  const marker = selected ? c.cyan("▼") : c.dim("│");
  const line = `  ${marker}   ${body}`;
  return [
    `  ${c.dim("│")}`,
    selected && !confirming ? inverse(` ${line.trimStart()} `) : line,
    `  ${c.dim("│")}`,
  ];
}

function renderModal(title: string, body: string[], W: number): string {
  const inner = Math.min(W - 4, 72);
  const hbar = "─".repeat(inner - 2);
  const pad = (s: string) => `  │  ${s.slice(0, inner - 6).padEnd(inner - 6)}  │`;
  const lines = [
    `  ┌─ ${title} ${"─".repeat(Math.max(0, inner - 4 - title.length))}┐`,
    pad(""),
    ...body.map(pad),
    pad(""),
    pad(c.dim("press any key to dismiss")),
    `  └${hbar}┘`,
    "",
  ];
  return lines.join("\n");
}

export function render(p: Pipeline, ui: UIState): string {
  const W = cols();
  const out: string[] = [];
  const rule = (label = "") =>
    label
      ? c.dim(`── ${label} ${"─".repeat(Math.max(0, W - label.length - 5))}`)
      : c.dim("─".repeat(W));

  // ── header
  const title = p.ghRepo ?? p.repoPath;
  const fetched = `↻ ${ago(p.fetchedAt)} ago`;
  const status = ui.busy ? c.yellow("working…") : c.dim(fetched);
  out.push(`${c.bold(mag("chong watch"))} ${c.dim("·")} ${c.bold(title)}   ${status}`);
  out.push("");

  // ── incoming (local branch + remote head lane, merged by time)
  const headLane = p.lanes[0].name;
  out.push(rule(`INCOMING · ${p.localBranch} · ${p.remote}/${headLane}`));
  type Tagged = { cm: typeof p.incoming[0]; src: "local" | "remote" };
  const localSet = new Set(p.localCommits.map((c) => c.sha));
  const tagged: Tagged[] = [
    ...p.localCommits.map((cm): Tagged => ({ cm, src: "local" })),
    ...p.incoming.filter((cm) => !localSet.has(cm.sha)).map((cm): Tagged => ({ cm, src: "remote" })),
  ];
  tagged.sort((a, b) => (a.cm.iso < b.cm.iso ? 1 : a.cm.iso > b.cm.iso ? -1 : 0));
  if (tagged.length === 0) {
    out.push(c.dim("  (no commits)"));
  } else {
    for (const { cm, src } of tagged.slice(0, 8)) {
      const isNew = src === "local" ? ui.newLocalShas.has(cm.sha) : ui.newShas.has(cm.sha);
      const srcTag = src === "local" ? c.cyan("local ") : c.dim("remote");
      const meta = c.dim(`${cm.rel} ${cm.author}`);
      const subj = trunc(cm.subject, W - 30 - cm.author.length);
      const row = `  ${srcTag}  ${c.yellow(cm.short)}  ${subj}  ${meta}`;
      out.push(isNew ? c.bgNew(row) : row);
    }
  }
  out.push("");

  // ── check notices
  if (ui.notices.length > 0) {
    out.push(rule("CHECKS"));
    for (const n of ui.notices.slice(0, 5)) out.push(`  ${n}`);
    out.push("");
  }

  // ── pipeline
  out.push(rule("PIPELINE  main → stage → prod"));
  out.push("");
  const keys = gapHotkeys(p.gaps);
  for (let i = 0; i < p.lanes.length; i++) {
    out.push(laneRow(p.lanes[i]));
    if (i < p.gaps.length) {
      const selected = ui.selectedGap === i;
      const confirming = ui.confirm === i;
      out.push(...gapRows(p.gaps[i], keys[i], selected, confirming));
    }
  }
  out.push("");

  // ── detail (queued commits for the selected gap)
  if (ui.expanded && p.gaps[ui.selectedGap]) {
    const gap = p.gaps[ui.selectedGap];
    out.push(rule(`QUEUED ${gap.from} → ${gap.to}`));
    if (gap.queued.length === 0) {
      out.push(c.dim("  (nothing queued)"));
    } else {
      for (const cm of gap.queued.slice(0, 12)) {
        const isNew = ui.newShas.has(cm.sha);
        const subj = trunc(cm.subject, W - 24 - cm.author.length);
        const row = `  ${c.yellow(cm.short)}  ${subj}  ${c.dim(`${cm.rel} ${cm.author}`)}`;
        out.push(isNew ? c.bgNew(row) : row);
      }
      if (gap.queued.length > 12) out.push(c.dim(`  … and ${gap.queued.length - 12} more`));
    }
    out.push("");
  }

  // ── status line + footer
  if (ui.status) out.push(`  ${ui.status}`);
  out.push(rule());
  const promoteKeys = p.gaps.map((g, i) => `[${keys[i]}] →${g.to}`).join("  ");
  out.push(c.dim(`  ${promoteKeys}   [↑/↓] select  [space] details  [f] fetch  [r] CI  [q] quit`));

  const frame = out.join("\n");
  if (ui.modal) return renderModal(ui.modal.title, ui.modal.body, W) + frame;
  return frame;
}
