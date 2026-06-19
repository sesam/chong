/**
 * Detect hardcoded, user-facing strings that were never wrapped in `t()`.
 *
 * `pnpm i18n` only extracts strings that are *already* wrapped in a translation
 * call, so copy that someone pasted in raw (e.g. a Slovenian sentence dropped
 * straight into a `.vue`/`.js` file) is invisible to it — it just renders in the
 * source locale forever, regardless of the chosen language. This module is the
 * complementary check: it scans source for string literals / template text that
 * look like human copy in the *non-source* locale and are NOT inside a `t(...)`.
 *
 * The app's translation source language is English (ASCII), so the high-signal
 * tells are (a) accented Latin letters (č, š, ž, ä, é, …) and (b) a short list of
 * distinctive Slovenian function words for the diacritic-free cases. Both are very
 * unlikely to appear in code tokens or English UI copy, which keeps false
 * positives low. The scanner is intentionally a *candidate flagger*: it points at
 * the right files/lines so a human (or an LLM, via the maintenance prompt) can do
 * the exhaustive wrapping — it does not try to be a complete extractor.
 */

export type Untranslated = {
  line: number; // 1-based line within the file
  text: string; // the offending string, trimmed (and truncated for display)
};

const SCANNABLE = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue"]);

/** True for source files worth scanning (skips .po/.json/.css/assets/etc.). */
export function isScannable(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && SCANNABLE.has(file.slice(dot).toLowerCase());
}

// Accented Latin letters (Latin-1 Supplement letters + Latin Extended-A) — covers
// č/š/ž and the wider European set, but deliberately excludes symbols like ²/€/—
// (those carry no language signal). The strongest "this is non-English copy" tell.
const ACCENTED = /[À-ÿĀ-ſ]/;

// Distinctive Slovenian function/domain words, used only for diacritic-free phrases.
// Chosen to (almost) never collide with English UI copy or code identifiers.
const SL_WORDS =
  /\b(?:ali|ki|za|od|ter|kot|brez|med|nad|pod|pri|glede|lahko|oz|oziroma|vaš|vaša|vaše|vam|izberite|izbiro|odvisno|obsega|vir|ogrevanja|hlajenje)\b/i;

/** Does this string look like human-readable copy in the non-source locale? */
export function localeSignal(text: string): boolean {
  const t = text.trim();
  if (!/\p{L}{2,}/u.test(t)) return false; // needs real letters, not just punctuation/digits
  if (ACCENTED.test(t)) return true; // accented letters → almost certainly non-English copy
  // Diacritic-free: only trust multi-word phrases that hit a Slovenian function word,
  // so a lone identifier like `od` or a CSS token can't trip the check.
  if (/\S\s+\S/.test(t) && SL_WORDS.test(t)) return true;
  return false;
}

// A string literal opener is "wrapped" when the code right before it is a
// translation call: t( · $t( · tc( · te( · i18n.t( · this.$t( …
const TRANS_CALL = /(?:[^\w$.]|^)(?:\$?t|tc|te|i18n\.t|i18n\.tc)\s*\(\s*$/;

type Cand = { value: string; line: number; wrapped: boolean };

/**
 * Walk JS/TS source, yielding string-literal candidates with their 1-based line
 * (offset by `baseLine`) and whether they're a translation-call argument. Skips
 * `//` / `/* *\/` comments and `${…}` template interpolations.
 */
function scanJs(src: string, baseLine: number): Cand[] {
  const out: Cand[] = [];
  const n = src.length;
  let i = 0;
  let line = baseLine;
  let buf = ""; // rolling tail of recent *code* text (no string/comment contents)
  const pushBuf = (ch: string) => {
    buf += ch;
    if (buf.length > 48) buf = buf.slice(-48);
  };

  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];

    if (ch === "\n") {
      line++;
      pushBuf(" ");
      i++;
      continue;
    }
    if (ch === "/" && nx === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && nx === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      pushBuf(" ");
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const startLine = line;
      const wrapped = TRANS_CALL.test(buf);
      let value = "";
      i++; // past the opening quote
      while (i < n) {
        const cc = src[i];
        if (cc === "\\") {
          if (src[i + 1] === "\n") line++;
          value += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (cc === "\n") {
          line++;
          value += "\n";
          i++;
          continue;
        }
        if (quote === "`" && cc === "$" && src[i + 1] === "{") {
          // skip the interpolation entirely; treat it as a word boundary
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const k = src[i];
            if (k === "{") depth++;
            else if (k === "}") depth--;
            else if (k === "\n") line++;
            i++;
          }
          value += " ";
          continue;
        }
        if (cc === quote) {
          i++;
          break;
        }
        value += cc;
        i++;
      }
      if (localeSignal(value)) out.push({ value: value.trim(), line: startLine, wrapped });
      buf = ""; // a string token resets the look-behind for the next opener
      continue;
    }

    pushBuf(ch);
    i++;
  }
  return out;
}

/** 1-based line number of a character offset within `content`. */
function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}

/** Replace each match of `re` with same-length blanks (newlines kept) to preserve offsets. */
function blank(content: string, re: RegExp): string {
  return content.replace(re, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Scan a `.vue` template (everything outside <script>/<style>) for hardcoded copy:
 * raw text nodes and string literals inside `{{ … }}` interpolations.
 */
function scanVueTemplate(content: string): Cand[] {
  const out: Cand[] = [];
  // Neutralise script/style blocks and comments so we only look at template markup.
  const tpl = blank(
    blank(
      blank(content, /<script\b[^>]*>[\s\S]*?<\/script>/gi),
      /<style\b[^>]*>[\s\S]*?<\/style>/gi,
    ),
    /<!--[\s\S]*?-->/g,
  );

  // Raw text nodes between tags, with `{{ … }}` interpolations stripped out.
  for (const m of tpl.matchAll(/>([^<]+)</g)) {
    const raw = m[1];
    const text = raw.replace(/\{\{[\s\S]*?\}\}/g, " ");
    if (localeSignal(text)) {
      const at = (m.index ?? 0) + 1; // past the '>'
      out.push({
        value: text.trim().replace(/\s+/g, " "),
        line: lineAt(content, at),
        wrapped: false,
      });
    }
  }

  // String literals inside interpolations (e.g. {{ 'Foo' }}); {{ t('Foo') }} is skipped.
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    out.push(...scanJs(m[1], lineAt(content, (m.index ?? 0) + 2)));
  }
  return out;
}

const DISPLAY_MAX = 80;
const truncate = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > DISPLAY_MAX ? `${one.slice(0, DISPLAY_MAX - 1)}…` : one;
};

/** Find hardcoded, non-source-locale strings not wrapped in `t()` within one file. */
export function findUntranslated(content: string, filename: string): Untranslated[] {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  const cands: Cand[] = [];

  if (ext === ".vue") {
    for (const m of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      const inner = m[1];
      const innerStart = (m.index ?? 0) + m[0].length - "</script>".length - inner.length;
      cands.push(...scanJs(inner, lineAt(content, innerStart)));
    }
    cands.push(...scanVueTemplate(content));
  } else {
    cands.push(...scanJs(content, 1));
  }

  return cands
    .filter((cd) => !cd.wrapped && cd.value.trim().length > 0)
    .map((cd) => ({ line: cd.line, text: truncate(cd.value) }));
}

/**
 * Parse a unified diff (`git show`/`git diff` output) into the set of *added*
 * new-side line numbers per file. Used to scope a commit scan to lines the commit
 * actually introduced, so pre-existing strings aren't re-flagged.
 */
export function addedLineNumbers(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let file: string | null = null;
  let cursor = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
      if (file && !map.has(file)) map.set(file, new Set());
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)/);
      cursor = m ? Number(m[1]) : cursor;
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      if (file) map.get(file)?.add(cursor);
      cursor++;
    } else if (raw.startsWith("-")) {
      // old side only — no new-side advance
    } else {
      cursor++; // context line
    }
  }
  return map;
}
