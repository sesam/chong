import { c } from "../util";
import type { CIState, Gap, Lane, Pipeline } from "./types";

const mag = (s: string) => `\x1b[35m${s}\x1b[0m`;
const inverse = (s: string) => `\x1b[7m${s}\x1b[0m`;

export type UIState = {
  selectedGap: number; // index into pipeline.gaps
  expanded: boolean; // show the queued-commit list for the selected gap
  status: string; // transient status / result line
  confirm: number | null; // gap index awaiting y/n confirmation
  busy: boolean; // a promote/fetch is in flight
  newShas: Set<string>; // commits on the head lane first seen since watch started
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

function gapRows(gap: Gap, selected: boolean, confirming: boolean): string[] {
  const how = gap.ff ? "fast-forward" : "merge";
  const drift = gap.behind > 0 ? c.red(`  ⚠ ${gap.behind} behind (drift)`) : "";

  let body: string;
  if (confirming) {
    body = c.bold(
      c.yellow(
        `▸ promote ${gap.ahead} commit(s)  ${gap.from} → ${gap.to}  (${how})?  [y] yes  [n] no`,
      ),
    );
  } else if (gap.ahead === 0) {
    body = c.dim(`✓ ${gap.to} is up to date with ${gap.from}`) + drift;
  } else {
    const action = selected ? c.cyan("[p] promote") : c.dim("[p] promote");
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

  // ── incoming
  out.push(rule(`INCOMING · ${p.remote}/${p.lanes[0].name}`));
  if (p.incoming.length === 0) {
    out.push(c.dim("  (no commits)"));
  } else {
    for (const cm of p.incoming.slice(0, 6)) {
      const fresh = ui.newShas.has(cm.sha) ? c.green("●") : " ";
      const meta = c.dim(`${cm.rel} ${cm.author}`);
      const subj = trunc(cm.subject, W - 24 - cm.author.length);
      out.push(`  ${fresh} ${c.yellow(cm.short)}  ${subj}  ${meta}`);
    }
  }
  out.push("");

  // ── pipeline
  out.push(rule("PIPELINE  main → stage → prod"));
  out.push("");
  for (let i = 0; i < p.lanes.length; i++) {
    out.push(laneRow(p.lanes[i]));
    if (i < p.gaps.length) {
      const selected = ui.selectedGap === i;
      const confirming = ui.confirm === i;
      out.push(...gapRows(p.gaps[i], selected, confirming));
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
        const subj = trunc(cm.subject, W - 24 - cm.author.length);
        out.push(`  ${c.yellow(cm.short)}  ${subj}  ${c.dim(`${cm.rel} ${cm.author}`)}`);
      }
      if (gap.queued.length > 12) out.push(c.dim(`  … and ${gap.queued.length - 12} more`));
    }
    out.push("");
  }

  // ── status line + footer
  if (ui.status) out.push(`  ${ui.status}`);
  out.push(rule());
  out.push(
    c.dim("  [↑/↓] select  [space] details  [p] promote  [f] fetch  [r] refresh CI  [q] quit"),
  );

  return out.join("\n");
}
