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
 *
 * To keep the report high-signal it deliberately does NOT flag:
 *   - string literals inside a `const` object/array initializer (data tables — see
 *     `constructionTimelineObcine.js`, colour maps, country lists, …),
 *   - arguments to `console.*` (logs are never user copy),
 *   - files under a `Debug*` path segment (debug-only tooling, not shipped UI).
 * It additionally surfaces two *advisories* that the literal-only heuristic would
 * otherwise miss: dynamic `t(variable)` keys (invisible to extraction) and
 * user-text built by `+` concatenation; plus a "suspicious escape" flag for a
 * stray `\n`/`\t` inside display copy.
 */

export type FindingKind = "hardcoded" | "dynamic" | "concat";

export type Untranslated = {
  line: number; // 1-based line within the file
  text: string; // the offending string, trimmed (and truncated for display)
  kind?: FindingKind; // default "hardcoded"; "dynamic" = t(variable); "concat" = '…'+x
  escape?: boolean; // true when the literal carried a stray \n / \t (suspicious in copy)
};

// .mjs is excluded: in practice it's build/tooling scripts, not product UI code.
const SCANNABLE = new Set([".js", ".jsx", ".ts", ".tsx", ".cjs", ".vue"]);

/** True for source files worth scanning (skips .mjs/.po/.json/.css/.md/assets/etc.). */
export function isScannable(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && SCANNABLE.has(file.slice(dot).toLowerCase());
}

// Directory segments that hold non-user-facing code (build scripts, tests, fixtures,
// static public assets, and generated/geo data tables).
const EXCLUDED_DIRS = new Set([
  "scripts",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "__snapshots__",
  "__fixtures__",
  "fixtures",
  "mocks",
  "data",
  "public",
  "e2e",
  "cypress",
  ".storybook",
]);

/**
 * Paths that are scannable by extension but aren't product UI code, so they're
 * skipped by default: build scripts, tests/specs/stories, fixtures/mocks, type
 * declarations, config, data files (e.g. `co2Data.js`, `mock-data.ts`, anything
 * under a `data/` or `public/` path segment — generated geo fixtures, static
 * assets), and anything under a `Debug*` path segment (debug-only tooling —
 * `DebugProjects/`, `DebugRoof/`, `DebugCo2Calculator/`, …). These routinely
 * carry non-English strings that should NOT be wrapped in t(). The
 * `chong check i18n --all` flag bypasses this to inspect everything.
 */
export function isExcludedPath(file: string): boolean {
  const segs = file.split("/");
  if (segs.some((s) => EXCLUDED_DIRS.has(s))) return true;
  // Debug-only tooling: any folder or file whose name starts with "Debug".
  if (segs.some((s) => /^Debug/.test(s))) return true;
  const base = segs[segs.length - 1];
  if (/\.(?:test|spec|stories|config)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/\.d\.ts$/i.test(base)) return true;
  if (/[a-z0-9]Data\.[cm]?[jt]sx?$/.test(base)) return true; // camelCase: co2Data.js, siteData.ts
  if (/(?:^|[-_.])(?:data|fixtures?|mock|mocks|seed|seeds)\.[cm]?[jt]sx?$/i.test(base)) return true;
  return false;
}

// Signals that a non-.vue file actually renders UI (and so its strings are
// user-facing and worth prioritising), rather than being plain logic/content.
const DISPLAY_SIGNALS = [
  /\.vue['"]/, // imports a .vue SFC
  /\bdefineComponent\s*\(/,
  /\bcreateElement\s*\(|\bReact\.createElement/,
  /\btemplate\s*:\s*[`'"]/, // Vue options-API inline template
  /<\/[A-Za-z][\w.-]*>/, // JSX/HTML closing tag
  /<[A-Z][\w.]*(?:\s|\/?>)/, // JSX component element
];

/**
 * Is this a "display" file — a Vue SFC, a JSX/TSX component, or a module that
 * renders UI? Its strings are the ones a user actually sees, so the scan reports
 * them first. Everything else (composables, services, content/data modules) is
 * secondary.
 */
export function isDisplayFile(file: string, content: string): boolean {
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";
  if (ext === ".vue" || ext === ".jsx" || ext === ".tsx") return true;
  return DISPLAY_SIGNALS.some((re) => re.test(content));
}

// A non-ASCII *Latin* letter (č/š/ž and the wider accented Latin set). Restricted
// to the Latin script via set subtraction so that (a) non-letter symbols sharing a
// block — × ÷ © ² € — are excluded, and (b) Greek/Cyrillic/math letters — Σ Δ µ —
// are excluded too: those show up in debug/units (`Σ rooms`, `max|Δ|`), not copy.
const ACCENTED = /[\p{Script=Latin}--\p{ASCII}]/v;

// Distinctive Slovenian function/domain words, used only for diacritic-free phrases.
// Chosen to (almost) never collide with English UI copy or code identifiers.
const SL_WORDS =
  /\b(?:ali|ki|za|od|ter|kot|brez|med|nad|pod|pri|glede|lahko|oz|oziroma|vaš|vaša|vaše|vam|izberite|izbiro|odvisno|obsega|vir|ogrevanja|hlajenje)\b/i;

/** Does this string look like human-readable copy in the non-source locale? */
export function localeSignal(text: string): boolean {
  const t = text.trim();
  if (!/\p{L}{2,}/u.test(t)) return false; // needs real letters, not just punctuation/digits
  if (ACCENTED.test(t)) return true; // accented Latin letters → almost certainly non-English copy
  // Diacritic-free: only trust multi-word phrases that hit a Slovenian function word,
  // so a lone identifier like `od` or a CSS token can't trip the check.
  if (/\S\s+\S/.test(t) && SL_WORDS.test(t)) return true;
  return false;
}

// A string literal opener is "wrapped" when the code right before it is a
// translation call: t( · $t( · tc( · te( · i18n.t( · this.t( · this.$t( …
const TRANS_CALL = /(?:[^\w$.]|^)(?:this\s*\.\s*)?(?:\$?t|tc|te|i18n\.t|i18n\.tc)\s*\(\s*$/;
// Same translation-call name, but tested against the code just before a `(` (so we
// can spot a *dynamic* `t(variable)` whose argument is not a string literal).
const TRANS_OPEN = /(?:[^\w$.]|^)(?:this\s*\.\s*)?(?:\$?t|tc|te|i18n\.t|i18n\.tc)\s*$/;
// A `console.<method>(` opener — its string arguments are diagnostics, never copy.
// Tolerates the optional-call form `console.table?.(` (used behind feature checks).
const CONSOLE_OPEN =
  /(?:^|[^\w$.])console\s*\.\s*(?:log|warn|error|info|debug|trace|group|groupCollapsed|groupEnd|table|dir|assert|count|time|timeEnd|timeLog)\s*(?:\?\.)?\s*$/;

// The code tail right before a string literal that marks it as a *comparison /
// lookup key*, not display copy: a `case '…'` label or an (in)equality check.
const KEY_POSITION = /(?:(?:^|[^\w$])case\s*|[=!]==?\s*)$/;
// Second (or later) argument to a lookup / pattern helper — PDF field labels,
// filename probes, EUP code prefixes, regex sources, etc. Single-arg
// startsWith/includes probes are included when the string is a short code token.
const LOOKUP_KEY_POSITION =
  /(?:fieldAfter|match|split)\s*\([^)]*,\s*$|(?:startsWith|endsWith|includes|search|indexOf)\s*\(\s*$|(?:startsWith|endsWith|includes|search|indexOf)\s*\([^)]*,\s*$|(?:^|[^\w$])(?:new\s+)?RegExp\s*\(\s*$|String\.raw\s*$|\.replace\([^,]+,\s*$/;
// Bracket member access like `props['POVRŠINA']`: the `[` follows an operand.
// A trailing keyword (`return [`, `yield [`, …) starts an array literal instead.
const BRACKET_AFTER_OPERAND = /(?:([A-Za-z_$][\w$]*)|[)\]])\s*\[\s*$/;
const PRE_BRACKET_KEYWORDS =
  /^(?:return|typeof|case|in|of|instanceof|new|delete|void|do|else|yield|await)$/;
const isBracketAccess = (buf: string): boolean => {
  const m = buf.match(BRACKET_AFTER_OPERAND);
  if (!m) return false;
  return m[1] === undefined || !PRE_BRACKET_KEYWORDS.test(m[1]);
};

// Characters that, as the last code token before a line break, mean the statement
// continues onto the next line (so a `const` initializer hasn't ended yet).
const CONTINUATION = new Set("=+-*/%&|^<>?:,.([{".split(""));

type Cand = {
  value: string;
  line: number;
  wrapped: boolean;
  kind: FindingKind;
  escape: boolean;
};

/**
 * Walk JS/TS source, yielding candidates with their 1-based line (offset by
 * `baseLine`). Tracks just enough structure to suppress non-copy strings:
 *   - inside a `console.*( … )` call,
 *   - inside a `const` object/array initializer (data tables),
 * and to surface dynamic `t(variable)` keys. Skips `//` / `/* *\/` comments and
 * `${…}` template interpolations (their inner code is rescanned separately).
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

  // ── structural state ───────────────────────────────────────────────────────
  const brackets: string[] = []; // open ( [ { chars, innermost last ("F" = Object.freeze()
  const depth = () => brackets.length;
  const parenConsole: boolean[] = []; // one bool per open "(" — true if a console.* call
  let declActive = false; // inside a `const … = …` initializer
  let declBaseDepth = 0; // bracket depth at which that `const` keyword sat
  let declHasFunc = false; // the const initializer contains a function (=> / function)
  let lastCode = ""; // last non-whitespace code char seen
  let eslintDynamicOff = false; // inside an `eslint-disable no-restricted-syntax` region
  let eslintDynamicOffLine = -1; // line covered by an `eslint-disable-next-line …`
  const inConsole = () => parenConsole.some(Boolean);
  // A string is "const data" only when every bracket opened inside the const
  // initializer is an object/array literal ({ or [) — never a call (…). That keeps
  // `const T = { a: '…' }` (a data table) suppressed while still flagging copy
  // passed to a call like `const x = format('…')`. An `Object.freeze(…)` paren
  // ("F") is transparent: `const D = Object.freeze({ a: '…' })` is still a table.
  const inConstData = () =>
    declActive &&
    !declHasFunc &&
    brackets.length > declBaseDepth &&
    brackets.slice(declBaseDepth).every((b) => b !== "(");
  // The project already polices dynamic t(variable) via ESLint's
  // no-restricted-syntax; an explicit eslint-disable for it is a deliberate
  // opt-out (e.g. element-catalog codes), so don't re-advise on those regions.
  const noteComment = (text: string) => {
    if (!/no-restricted-syntax/.test(text)) return;
    if (/eslint-disable-next-line/.test(text)) eslintDynamicOffLine = line + 1;
    else if (/eslint-disable(?!-)/.test(text)) eslintDynamicOff = true;
    else if (/eslint-enable/.test(text)) eslintDynamicOff = false;
  };

  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];

    // End a `const` initializer: back at its base depth and either a `;` or a
    // newline whose preceding token completes the expression (handles ASI / no-semi).
    if (declActive && depth() <= declBaseDepth) {
      if (ch === ";" || (ch === "\n" && lastCode !== "" && !CONTINUATION.has(lastCode))) {
        declActive = false;
        declHasFunc = false;
      }
    }

    if (ch === "\n") {
      line++;
      pushBuf(" ");
      i++;
      continue;
    }
    if (ch === "/" && nx === "/") {
      i += 2;
      const start = i;
      while (i < n && src[i] !== "\n") i++;
      noteComment(src.slice(start, i));
      continue;
    }
    if (ch === "/" && nx === "*") {
      i += 2;
      const start = i;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      noteComment(src.slice(start, i));
      i += 2;
      pushBuf(" ");
      continue;
    }

    // A `/` that isn't a comment is either division or a regex literal. Guessing
    // wrong desyncs the lexer (a quote inside the regex opens a phantom string that
    // swallows code), so detect regex position: it follows an operator, an opening
    // bracket, or a keyword — never an operand (identifier, `)`, `]`, number).
    if (ch === "/") {
      const before = buf.replace(/\s+$/, "");
      const last = before.slice(-1);
      const isRegex =
        before === "" ||
        "([{,;:=!&|?+-*%^~<>".includes(last) ||
        /(?:^|[^\w$])(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/.test(
          before,
        );
      if (isRegex) {
        i++; // past the opening /
        let inClass = false;
        while (i < n) {
          const cc = src[i];
          if (cc === "\\") {
            i += 2;
            continue;
          }
          if (cc === "\n") {
            i++;
            break;
          } // regex can't span a raw newline → bail
          if (cc === "[") inClass = true;
          else if (cc === "]") inClass = false;
          else if (cc === "/" && !inClass) {
            i++;
            break;
          }
          i++;
        }
        pushBuf(" ");
        lastCode = "/";
        continue;
      }
      // otherwise: division operator — fall through to record it as code
    }

    // Opening bracket: maintain depth and the console-call paren stack, and detect a
    // dynamic `t(variable)` argument (a translation call whose first arg isn't a string).
    if (ch === "(") {
      if (TRANS_OPEN.test(buf)) {
        let j = i + 1;
        while (j < n && /\s/.test(src[j] ?? "")) j++;
        const c0 = src[j] ?? "";
        if (c0 && !/['"`]/.test(c0) && /[A-Za-z_$]/.test(c0)) {
          let arg = "";
          let k = j;
          while (k < n && src[k] !== ")" && src[k] !== "," && arg.length < 40) {
            if (src[k] === "\n") break;
            arg += src[k];
            k++;
          }
          if (!eslintDynamicOff && line !== eslintDynamicOffLine) {
            out.push({ value: arg.trim(), line, wrapped: false, kind: "dynamic", escape: false });
          }
        }
      }
      parenConsole.push(CONSOLE_OPEN.test(buf));
      brackets.push(/Object\s*\.\s*freeze\s*$/.test(buf) ? "F" : "(");
      pushBuf("(");
      lastCode = "(";
      i++;
      continue;
    }
    if (ch === ")") {
      parenConsole.pop();
      const top = brackets[brackets.length - 1];
      if (top === "(" || top === "F") brackets.pop();
      pushBuf(")");
      lastCode = ")";
      i++;
      continue;
    }
    if (ch === "[" || ch === "{") {
      brackets.push(ch);
      pushBuf(ch);
      lastCode = ch;
      i++;
      continue;
    }
    if (ch === "]" || ch === "}") {
      const want = ch === "]" ? "[" : "{";
      if (brackets[brackets.length - 1] === want) brackets.pop();
      pushBuf(ch);
      lastCode = ch;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const startLine = line;
      const wrapped = TRANS_CALL.test(buf);
      // A `case '…'` label, `=== '…'` comparison, or `obj['…']` member access is a
      // lookup key, not display copy.
      const keyish = KEY_POSITION.test(buf) || LOOKUP_KEY_POSITION.test(buf) || isBracketAccess(buf);
      const precededByPlus = /\+\s*$/.test(buf);
      let value = "";
      let escape = false;
      i++; // past the opening quote
      while (i < n) {
        const cc = src[i];
        if (cc === "\\") {
          const e = src[i + 1];
          if (e === "\n") {
            line++; // line-continuation: backslash before a real newline, contributes nothing
          } else if (e === "n") {
            value += "\n";
            escape = true;
          } else if (e === "t") {
            value += "\t";
            escape = true;
          } else if (e === "r") {
            value += "\r";
            escape = true;
          } else {
            value += e ?? "";
          }
          i += 2;
          continue;
        }
        if (cc === "\n") {
          line++;
          // Only template literals hold raw newlines; a newline inside '…' or "…"
          // means we mis-read the opening quote (desync) — bail at the line.
          if (quote !== "`") {
            i++;
            break;
          }
          value += "\n";
          i++;
          continue;
        }
        if (quote === "`" && cc === "$" && src[i + 1] === "{") {
          // skip the interpolation entirely; treat it as a word boundary
          i += 2;
          let d = 1;
          while (i < n && d > 0) {
            const k = src[i];
            if (k === "{") d++;
            else if (k === "}") d--;
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
      // A string is non-copy when it's a console argument, a value inside a
      // `const` data table (object/array initializer), or a lookup key
      // (case label / comparison / bracket access) — skip those entirely.
      const suppressed = keyish || inConsole() || inConstData();
      if (!suppressed && localeSignal(value)) {
        let followedByPlus = false;
        let p = i;
        while (p < n && /\s/.test(src[p] ?? "")) p++;
        if (src[p] === "+") followedByPlus = true;
        out.push({
          value: value.trim(),
          line: startLine,
          wrapped,
          kind: precededByPlus || followedByPlus ? "concat" : "hardcoded",
          escape,
        });
      }
      buf = ")"; // a string is an operand: a following `/` is division, not regex
      lastCode = ")";
      continue;
    }

    // Plain code char. Record it, then watch for `const` / function markers.
    if (!/\s/.test(ch)) lastCode = ch;
    pushBuf(ch);
    i++;

    // A `const` keyword just completed (followed by a space/tab — "constructor"
    // and friends never match because the boundary char is a word char).
    if (!declActive && /(?:^|[^\w$.])const[ \t]$/.test(buf)) {
      declActive = true;
      declBaseDepth = depth();
      declHasFunc = false;
    }
    // A function inside the initializer means its body is real code, not a data
    // table, so const-data suppression must not apply to strings within it.
    if (declActive && (buf.endsWith("=>") || /(?:^|[^\w$.])function\b/.test(buf))) {
      declHasFunc = true;
    }
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
        kind: "hardcoded",
        escape: false,
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

// Safety net for any residual lexer desync: a captured "string" that carries code
// syntax (arrow fns, method calls, declarations, statement breaks) is not copy.
const CODE_ISH =
  /=>|\)\s*\{|\?\.|;[\s)]|\.\w+\(|\b(?:const|let|var|function|return|new|RegExp|forEach|map|filter)\b/;
// Regex pattern sources (e.g. `(?:^|\\n)…`, `[a-zčšž]…`) are never display copy.
const REGEX_ISH = /\\[sdnwtrbDSW]|(?:\(\?[:=!])|(?:\[\^?[\w-]*\])|(?:\{\d)|(?:\|[^|]+\|)/;
const looksLikeCode = (s: string) => CODE_ISH.test(s) || REGEX_ISH.test(s);
// Short spatial-unit / EUP code prefixes (ŽUV-, KRŠ-) used in startsWith probes.
const looksLikeCodePrefix = (s: string) => /^[\p{Lu}ŠŽČ0-9-]{2,8}-$/u.test(s.trim());

// Opt-out pragmas for files/lines that intentionally carry non-source-locale
// strings that are NOT user copy (LLM prompt/context builders, ops diagnostics).
// Usage: `// chong-i18n-disable-file — <why>` anywhere in the file, or
// `// chong-i18n-disable-next-line <why>` / a trailing `// chong-i18n-disable-line`.
const PRAGMA_FILE = /chong-i18n-disable-file/;

/** Line numbers (1-based) covered by a line-level chong-i18n pragma. */
function pragmaLines(content: string): Set<number> {
  const out = new Set<number>();
  const lines = content.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln] ?? "";
    if (s.includes("chong-i18n-disable-next-line")) out.add(ln + 2);
    else if (s.includes("chong-i18n-disable-line")) out.add(ln + 1);
  }
  return out;
}

// Every string literal passed to a translation call anywhere in the file —
// including `// t('…')` marker comments the extractor workflow recommends. Used
// to suppress the *unwrapped* twin of a wrapped string: lookup tables and
// normalizers ('X': () => t('X'), case 'X': return t('X')) repeat the msgid as a
// key, and that key is not itself display copy.
function wrappedLiterals(content: string): Set<string> {
  const out = new Set<string>();
  const re =
    /(?:[^\w$.]|^)(?:this\s*\.\s*)?(?:\$?t|tc|te|i18n\.tc?)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])+?)\1/g;
  for (const m of content.matchAll(re)) {
    out.add((m[2] ?? "").replace(/\\(.)/g, "$1").trim());
  }
  return out;
}

/** Find hardcoded, non-source-locale strings not wrapped in `t()` within one file. */
export function findUntranslated(content: string, filename: string): Untranslated[] {
  if (PRAGMA_FILE.test(content)) return [];
  const skipLines = pragmaLines(content);
  const wrappedElsewhere = wrappedLiterals(content);
  // A `// t('…')` marker comment is the documented fix for dynamic keys (it makes
  // the extractor see them). A file that carries markers has handled its dynamic
  // t(variable) sites — stop re-advising on it.
  const hasTMarkers = /\/\/\s*t\(\s*['"`]/.test(content);
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
    .filter((cd) => {
      if (cd.wrapped || cd.value.trim().length === 0) return false;
      if (skipLines.has(cd.line)) return false;
      if (cd.kind === "dynamic") return !hasTMarkers; // advisory: the arg is an identifier, not copy
      if (cd.kind === "hardcoded" && wrappedElsewhere.has(cd.value.trim())) return false;
      if (cd.kind === "hardcoded" && looksLikeCodePrefix(cd.value)) return false;
      return !looksLikeCode(cd.value);
    })
    .map((cd) => {
      const f: Untranslated = { line: cd.line, text: truncate(cd.value), kind: cd.kind };
      if (cd.escape) f.escape = true;
      return f;
    });
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
