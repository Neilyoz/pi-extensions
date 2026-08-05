/**
 * Bash target extraction for pi-access-denied — recover the absolute paths a
 * bash command appears to touch OUTSIDE cwd (absolute paths, `~`, `$HOME`, and
 * `..` traversals).
 *
 * This uses a real bash parser ([unbash](https://github.com/webpro-nl/unbash))
 * to build a structured AST rather than a flat tokenizer. The structural parse
 * is what keeps the gate trustworthy:
 *
 *   - **Quoted strings stay whole.** A multi-line `git commit -m "…"` message
 *     is a single Word whose inner text never surfaces as bare path tokens —
 *     eliminating the false positives that trained users to hit "always allow"
 *     and thereby disarmed the gate exactly when `rm -r /` later appears.
 *   - **Nested commands recurse.** Command substitutions `$(cmd)`, backticks,
 *     process substitutions `<(cmd)`, subshells, and every control-flow body
 *     (`if`/`for`/`while`/`case`/…) are walked, so paths hidden inside nested
 *     commands are still caught.
 *   - **Expansions are recognized.** `${HOME}` is a parameter expansion, not
 *     split on the braces; `=~` is a binary test operator, not a bare `~`.
 *
 * This is PURE EXTRACTION: it returns every escaping-looking candidate without
 * judging allow/deny — classification is the PathManager's job. It is a
 * deliberately conservative heuristic (bash is Turing-complete; perfect static
 * analysis is impossible). Malformed input yields a best-effort partial AST
 * (unbash collects errors instead of throwing); we walk whatever we get.
 *
 * Quoted words are treated as data literals and NOT scanned for paths — a
 * quoted run is an argument's value (e.g. `echo '…'`), not a file the command
 * opens. The one recursive exception is command/process substitutions inside
 * quotes (`"$(rm /x)"`), which DO execute and are always walked.
 */
import * as path from "node:path";
import { parse } from "unbash";
import type {
  CompoundList,
  Node,
  Redirect,
  Script,
  Statement,
  TestExpression,
  Word,
  WordPart,
} from "unbash";
import { resolveTarget } from "./paths.ts";

// ── Windows-native path detection ───────────────────────────────────────────
// A drive-letter prefix (`C:\…`, `D:/…`) uses backslash (or, under Git Bash,
// forward slash) as a path *separator*, not a shell escape. Such tokens must
// reach resolveTarget with separators intact — using the parser's dequoted
// `value` would collapse `C:\Users\me` to `C:Usersme`. Pure of platform so it
// is unit-testable anywhere.
const WIN_NATIVE_RE = /^[A-Za-z]:[\\/]/;

/** True if `token` is a Windows-native absolute path with a drive letter. */
export function isWindowsNativePath(token: string): boolean {
  return WIN_NATIVE_RE.test(token);
}

// ── Path candidate classification (pure) ────────────────────────────────────

/** Does this token look like it could escape cwd? */
function isEscapingCandidate(token: string): boolean {
  if (token.startsWith("/") || path.isAbsolute(token)) return true; // absolute (posix + windows native)
  if (token === "~" || token.startsWith("~/")) return true; // home
  if (token === "$HOME" || token.startsWith("$HOME/")) return true; // home
  if (token === ".." || token.startsWith("../")) return true; // parent climb
  if (/\/\.\.(\/|$)/.test(token)) return true; // embedded parent: a/.. or a/../b
  return false;
}

/** Normalize `${HOME}` → `$HOME` so the home-prefix check matches both forms. */
function normalizeHome(token: string): string {
  return token.replaceAll("${HOME}", "$HOME");
}

/** Add `token` (resolved absolute) to `targets` if it is an escaping candidate. */
function consider(token: string, cwd: string, targets: Set<string>): void {
  if (token.startsWith("-")) return; // option flag (--foo, -rf)
  if (!isEscapingCandidate(token)) return;
  targets.add(resolveTarget(token, cwd));
}

// ── Word inspection ─────────────────────────────────────────────────────────

/**
 * Word parts that defeat static path analysis: quoted literals (data, not a
 * path) and variable expansions other than `$HOME`/`${HOME}` (unknowable at
 * parse time). Literal text, brace/glob patterns, and `$HOME` are left through.
 */
function isUnanalyzable(p: WordPart): boolean {
  switch (p.type) {
    case "SingleQuoted":
    case "DoubleQuoted":
    case "AnsiCQuoted":
    case "LocaleString":
      return true;
    case "SimpleExpansion":
      return p.text !== "$HOME";
    case "ParameterExpansion":
      return p.parameter !== "HOME";
    default:
      return false; // Literal, BraceExpansion, ExtendedGlob, ArithmeticExpansion, CommandExpansion, ProcessSubstitution
  }
}

/**
 * Recurse into a word's parts (and quoted children) for nested commands:
 * `$(cmd)`, backticks, `<(cmd)`, `>(cmd)`. These execute regardless of the
 * quoting context they appear in (even inside `"$(...)"`), so they are always
 * walked. Bare literals inside quotes (e.g. a commit-message body) are NOT
 * scanned for paths — only command boundaries recurse.
 */
function collectNested(parts: WordPart[] | undefined, cwd: string, targets: Set<string>): void {
  if (!parts) return;
  for (const p of parts) {
    switch (p.type) {
      case "CommandExpansion":
      case "ProcessSubstitution":
        if (p.script) walkScript(p.script, cwd, targets);
        break;
      case "DoubleQuoted":
      case "LocaleString":
        collectNested(p.parts, cwd, targets);
        break;
      case "BraceExpansion":
      case "ExtendedGlob":
        collectNested(p.parts, cwd, targets);
        break;
      case "ParameterExpansion":
        // ${var:-$(cmd)} and ${arr[$(cmd)]} may hide nested commands.
        if (p.operand) scanWord(p.operand, cwd, targets);
        collectNested(p.indexParts, cwd, targets);
        break;
      // Literal / SimpleExpansion / AnsiCQuoted / ArithmeticExpansion: no nested commands.
    }
  }
}

/**
 * Inspect a single word for an escaping-path candidate, and recurse into any
 * nested command substitutions it contains. Shared by command names, suffix
 * args, redirect targets, and test operands.
 */
function scanWord(word: Word | undefined, cwd: string, targets: Set<string>): void {
  if (!word) return;
  // `parts` is a lazy getter (NOT an own enumerable property) — access it
  // explicitly. A walker driven by Object.keys / spread / structuredClone would
  // silently see zero expansions and miss every nested command.
  const parts = word.parts ?? [];
  collectNested(parts, cwd, targets);

  // Windows-native path: backslashes are separators — use raw `text`, not the
  // dequoted `value` (which collapses `C:\Users` → `C:Users`).
  if (isWindowsNativePath(word.text)) {
    consider(word.text, cwd, targets);
    return;
  }
  // Quoted data literal, or unresolvable variable — not a static path. Nested
  // commands inside it were already collected above.
  if (parts.some(isUnanalyzable)) return;

  consider(normalizeHome(word.value), cwd, targets);
}

// ── AST traversal ───────────────────────────────────────────────────────────

function walkScript(script: Script, cwd: string, targets: Set<string>): void {
  for (const stmt of script.commands) walkStatement(stmt, cwd, targets);
}

function walkCompound(cl: CompoundList, cwd: string, targets: Set<string>): void {
  for (const stmt of cl.commands) walkStatement(stmt, cwd, targets);
}

function walkRedirect(r: Redirect, cwd: string, targets: Set<string>): void {
  if (r.target) scanWord(r.target, cwd, targets); // redirect target IS a file path
  // Heredoc body: quoted (`<<'EOF'`) is literal text the shell never executes
  // — skip. Unquoted (`<<EOF`) is parsed; its nested `$(cmd)` substitutions DO
  // execute, so recurse into `body` when the parser provides it.
  if (r.body) collectNested(r.body.parts ?? [], cwd, targets);
}

function walkTestExpr(e: TestExpression, cwd: string, targets: Set<string>): void {
  switch (e.type) {
    case "TestUnary":
      scanWord(e.operand, cwd, targets);
      break;
    case "TestBinary":
      scanWord(e.left, cwd, targets);
      scanWord(e.right, cwd, targets);
      break;
    case "TestLogical":
      walkTestExpr(e.left, cwd, targets);
      walkTestExpr(e.right, cwd, targets);
      break;
    case "TestNot":
      walkTestExpr(e.operand, cwd, targets);
      break;
    case "TestGroup":
      walkTestExpr(e.expression, cwd, targets);
      break;
  }
}

function walkNode(node: Node, cwd: string, targets: Set<string>): void {
  switch (node.type) {
    case "Command": {
      scanWord(node.name, cwd, targets);
      for (const w of node.suffix) scanWord(w, cwd, targets);
      for (const r of node.redirects) walkRedirect(r, cwd, targets);
      // Assignment values are data (not file access) — only recurse for nested
      // commands, never scan them as paths.
      for (const a of node.prefix) {
        if (a.value) collectNested(a.value.parts ?? [], cwd, targets);
        if (a.array) for (const w of a.array) collectNested(w.parts ?? [], cwd, targets);
      }
      break;
    }
    case "Pipeline":
    case "AndOr":
      for (const c of node.commands) walkNode(c, cwd, targets);
      break;
    case "If":
      walkCompound(node.clause, cwd, targets);
      walkCompound(node.then, cwd, targets);
      if (node.else) {
        // `else` is either a nested `If` (elif chain) or a CompoundList.
        if (node.else.type === "If") walkNode(node.else, cwd, targets);
        else walkCompound(node.else, cwd, targets);
      }
      break;
    case "For":
    case "Select":
      for (const w of node.wordlist) scanWord(w, cwd, targets);
      walkCompound(node.body, cwd, targets);
      break;
    case "While":
      walkCompound(node.clause, cwd, targets);
      walkCompound(node.body, cwd, targets);
      break;
    case "Case": {
      scanWord(node.word, cwd, targets);
      for (const item of node.items) {
        for (const p of item.pattern) scanWord(p, cwd, targets);
        walkCompound(item.body, cwd, targets);
      }
      break;
    }
    case "Subshell":
    case "BraceGroup":
      walkCompound(node.body, cwd, targets);
      break;
    case "Function":
    case "Coproc":
      walkNode(node.body, cwd, targets);
      for (const r of node.redirects) walkRedirect(r, cwd, targets);
      break;
    case "CompoundList":
      walkCompound(node, cwd, targets);
      break;
    case "TestCommand":
      walkTestExpr(node.expression, cwd, targets);
      break;
    case "ArithmeticFor":
      walkCompound(node.body, cwd, targets);
      break;
    case "ArithmeticCommand":
      break; // `(( … ))` — pure arithmetic, no path operands.
    case "Statement":
      walkStatement(node, cwd, targets);
      break;
  }
}

function walkStatement(stmt: Statement, cwd: string, targets: Set<string>): void {
  walkNode(stmt.command, cwd, targets);
  for (const r of stmt.redirects) walkRedirect(r, cwd, targets);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract the de-duplicated set of normalized absolute paths a bash command
 * APPEARS to reach OUTSIDE cwd. Heuristic — see module doc for blind spots.
 *
 * Pure extraction: returns every escaping-looking candidate without judging
 * allow/deny (that is the PathManager's job).
 */
export function extractBashTargets(command: string, cwd: string): string[] {
  const targets = new Set<string>();
  let ast: Script;
  try {
    ast = parse(command);
  } catch {
    return []; // unbash is best-effort and should not throw, but guard anyway.
  }
  walkScript(ast, cwd, targets);
  return [...targets];
}
