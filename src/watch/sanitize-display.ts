/**
 * Shared sanitizer for every untrusted string this tool prints to the terminal.
 *
 * Three sources, all attacker-influenced, all rendered straight into the watch TUI:
 * the worktree owner file (`worktree-claim.ts`, local JSON another process on the
 * machine can write), the deploy claim (`deploy-claim.ts`, an S3 object anyone with
 * bucket write access can write), and git commit metadata (`repo.ts`, author and
 * subject — which needs only a merged PR, and is therefore the most reachable of the
 * three). An unsanitized field here is a terminal-injection and identity-spoofing
 * vector, so all three go through this one function rather than three near-copies:
 * the first version of this shipped as two divergent denylists that had already
 * drifted apart on whether they trimmed.
 *
 * This is deliberately an ALLOWLIST, not a denylist: after NFC normalization, keep only
 * Unicode categories L (letter), N (number), P (punctuation) and Zs (space separator),
 * and drop everything else. The two previous per-file implementations here were both
 * denylists — strip 7-bit CSI (`\x1b[...`) then `[\x00-\x1f\x7f]` — and both missed the
 * 8-bit C1 control range (U+0080-U+009F), which C1-aware terminals such as xterm and
 * iTerm2 still act on as escape/CSI/OSC introducers even though it never has a `\x1b`
 * byte in it. An allowlist can't repeat that mistake: anything not explicitly a
 * letter/number/punctuation/space is dropped by construction, including C0, C1, DEL,
 * DCS/APC/PM payloads, format characters (`\p{Cf}`, e.g. the U+202E RTL override and
 * U+200B zero-width space), and stray combining marks (`\p{M}`, the Zalgo-stacking
 * technique used to visually hijack a colleague's rendered name) — none of those
 * categories are in the allowlist, so they never survive regardless of what new escape
 * family shows up next. Do not "optimize" this back into a denylist of bytes to reject.
 */
export function sanitizeDisplayText(value: string, maxLen: number): string {
  const normalized = value.normalize("NFC");
  let out = "";
  for (const ch of normalized) {
    if (/^[\p{L}\p{N}\p{P}\p{Zs}]$/u.test(ch)) out += ch;
  }
  // Trim first so an all-blank/all-stripped field reads as truly empty for the
  // caller's own "unknown" / reject-the-claim fallback, then cap length.
  return out.trim().slice(0, maxLen);
}
