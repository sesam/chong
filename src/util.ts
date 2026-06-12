const TTY = process.stdout.isTTY;

export const c = {
  dim: (s: string) => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (TTY ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (TTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (TTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (TTY ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (TTY ? `\x1b[36m${s}\x1b[0m` : s),
  // Dark green bg — re-applies after every reset so nested color codes don't clear it.
  bgNew: (s: string) => {
    if (!TTY) return s;
    const BG = "\x1b[48;5;22m";
    return BG + s.replace(/\x1b\[0m/g, `\x1b[0m${BG}`) + "\x1b[0m";
  },
};

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export type Args = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function ask(q: string): string {
  // Bun exposes a synchronous global prompt(); fall back to readline if missing.
  const g = globalThis as { prompt?: (q: string) => string | null };
  if (typeof g.prompt === "function") return (g.prompt(q) ?? "").trim();
  process.stdout.write(q);
  return "";
}
