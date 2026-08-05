/**
 * Bash target extraction for pi-access-denied — recover the absolute paths a
 * bash command appears to touch OUTSIDE cwd (absolute paths, `~`, `$HOME`, and
 * `..` traversals), each paired with the leaf command that produced it.
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
 *
 * ## Source tracking
 *
 * Each extracted path is paired with `source`: the text of the leaf command
 * (Command / TestCommand node) that produced it, sliced from the original
 * command string via the node's `pos`/`end`. Root nodes AND verbatim nested
 * substitutions (`$(…)`, `` `…` `` without backslash escapes) index the caller's
 * source directly, so the slice is exact at every depth. This lets the
 * authorization panel show "find /" rather than just "/", so the user can tell
 * a read-only `find` from `rm -rf` before deciding.
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

/** A path the command appears to reach, plus the leaf command that produced it. */
export interface ExtractedTarget {
  /** Resolved absolute path. */
  path: string;
  /** Text of the leaf command (e.g. `find / -name *.log`) that produced `path`. Absent when meaningless. */
  source?: string;
}

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

/**
 * Record `token` (resolved absolute) into `targets` if it is an escaping
 * candidate. `path → source` is first-write-wins: the first leaf command that
 * surfaces a path owns its display source (later commands hitting the same path
 * add nothing — the user already sees a representative command for it).
 */
function consider(token: string, cwd: string, source: string, targets: Map<string, string>): void {
  if (token.startsWith("-")) return; // option flag (--foo, -rf)
  if (!isEscapingCandidate(token)) return;
  const resolved = resolveTarget(token, cwd);
  if (!targets.has(resolved)) targets.set(resolved, source);
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
function collectNested(parts: WordPart[] | undefined, command: string, cwd: string, targets: Map<string, string>): void {
  if (!parts) return;
  for (const p of parts) {
    switch (p.type) {
      case "CommandExpansion":
      case "ProcessSubstitution":
        if (p.script) walkScript(p.script, command, cwd, targets);
        break;
      case "DoubleQuoted":
      case "LocaleString":
        collectNested(p.parts, command, cwd, targets);
        break;
      case "BraceExpansion":
      case "ExtendedGlob":
        collectNested(p.parts, command, cwd, targets);
        break;
      case "ParameterExpansion":
        // ${var:-$(cmd)} and ${arr[$(cmd)]} may hide nested commands.
        if (p.operand) scanWord(p.operand, command, cwd, p.text, targets);
        collectNested(p.indexParts, command, cwd, targets);
        break;
      // Literal / SimpleExpansion / AnsiCQuoted / ArithmeticExpansion: no nested commands.
    }
  }
}

/**
 * Inspect a single word for an escaping-path candidate (attributed to `source`),
 * and recurse into any nested command substitutions it contains. Shared by
 * command names, suffix args, redirect targets, and test operands.
 */
function scanWord(word: Word | undefined, cwd: string, source: string, command: string, targets: Map<string, string>): void {
  if (!word) return;
  // `parts` is a lazy getter (NOT an own enumerable property) — access it
  // explicitly. A walker driven by Object.keys / spread / structuredClone would
  // silently see zero expansions and miss every nested command.
  const parts = word.parts ?? [];
  collectNested(parts, command, cwd, targets);

  // Windows-native path: backslashes are separators — use raw `text`, not the
  // dequoted `value` (which collapses `C:\Users` → `C:Users`).
  if (isWindowsNativePath(word.text)) {
    consider(word.text, cwd, source, targets);
    return;
  }
  // Quoted data literal, or unresolvable variable — not a static path. Nested
  // commands inside it were already collected above.
  if (parts.some(isUnanalyzable)) return;

  consider(normalizeHome(word.value), cwd, source, targets);
}

// ── AST traversal ───────────────────────────────────────────────────────────

function walkScript(script: Script, command: string, cwd: string, targets: Map<string, string>): void {
  for (const stmt of script.commands) walkStatement(stmt, command, cwd, targets);
}

function walkCompound(cl: CompoundList, command: string, cwd: string, targets: Map<string, string>): void {
  for (const stmt of cl.commands) walkStatement(stmt, command, cwd, targets);
}

function walkRedirect(r: Redirect, cwd: string, source: string, command: string, targets: Map<string, string>): void {
  if (r.target) scanWord(r.target, cwd, source, command, targets); // redirect target IS a file path
  // Heredoc body: quoted (`<<'EOF'`) is literal text the shell never executes
  // — skip. Unquoted (`<<EOF`) is parsed; its nested `$(cmd)` substitutions DO
  // execute, so recurse into `body` when the parser provides it.
  if (r.body) collectNested(r.body.parts ?? [], command, cwd, targets);
}

function walkTestExpr(e: TestExpression, cwd: string, source: string, command: string, targets: Map<string, string>): void {
  switch (e.type) {
    case "TestUnary":
      scanWord(e.operand, cwd, source, command, targets);
      break;
    case "TestBinary":
      scanWord(e.left, cwd, source, command, targets);
      scanWord(e.right, cwd, source, command, targets);
      break;
    case "TestLogical":
      walkTestExpr(e.left, cwd, source, command, targets);
      walkTestExpr(e.right, cwd, source, command, targets);
      break;
    case "TestNot":
      walkTestExpr(e.operand, cwd, source, command, targets);
      break;
    case "TestGroup":
      walkTestExpr(e.expression, cwd, source, command, targets);
      break;
  }
}

function walkNode(node: Node, command: string, cwd: string, targets: Map<string, string>): void {
  switch (node.type) {
    case "Command": {
      // Leaf command text — verbatim slice of the original source.
      const source = command.slice(node.pos, node.end);
      scanWord(node.name, cwd, source, command, targets);
      for (const w of node.suffix) scanWord(w, cwd, source, command, targets);
      for (const r of node.redirects) walkRedirect(r, cwd, source, command, targets);
      // Assignment values are data (not file access) — only recurse for nested
      // commands, never scan them as paths.
      for (const a of node.prefix) {
        if (a.value) collectNested(a.value.parts ?? [], command, cwd, targets);
        if (a.array) for (const w of a.array) collectNested(w.parts ?? [], command, cwd, targets);
      }
      break;
    }
    case "TestCommand": {
      const source = command.slice(node.pos, node.end);
      walkTestExpr(node.expression, cwd, source, command, targets);
      break;
    }
    case "Pipeline":
    case "AndOr":
      for (const c of node.commands) walkNode(c, command, cwd, targets);
      break;
    case "If":
      walkCompound(node.clause, command, cwd, targets);
      walkCompound(node.then, command, cwd, targets);
      if (node.else) {
        // `else` is either a nested `If` (elif chain) or a CompoundList.
        if (node.else.type === "If") walkNode(node.else, command, cwd, targets);
        else walkCompound(node.else, command, cwd, targets);
      }
      break;
    case "For":
    case "Select":
      for (const w of node.wordlist) scanWord(w, cwd, command.slice(node.pos, node.end), command, targets);
      walkCompound(node.body, command, cwd, targets);
      break;
    case "While":
      walkCompound(node.clause, command, cwd, targets);
      walkCompound(node.body, command, cwd, targets);
      break;
    case "Case": {
      const source = command.slice(node.pos, node.end);
      scanWord(node.word, cwd, source, command, targets);
      for (const item of node.items) {
        for (const p of item.pattern) scanWord(p, cwd, source, command, targets);
        walkCompound(item.body, command, cwd, targets);
      }
      break;
    }
    case "Subshell":
    case "BraceGroup":
      walkCompound(node.body, command, cwd, targets);
      break;
    case "Function":
    case "Coproc":
      walkNode(node.body, command, cwd, targets);
      for (const r of node.redirects) walkRedirect(r, cwd, command.slice(node.pos, node.end), command, targets);
      break;
    case "CompoundList":
      walkCompound(node, command, cwd, targets);
      break;
    case "ArithmeticFor":
      walkCompound(node.body, command, cwd, targets);
      break;
    case "ArithmeticCommand":
      break; // `(( … ))` — pure arithmetic, no path operands.
    case "Statement":
      walkStatement(node, command, cwd, targets);
      break;
  }
}

function walkStatement(stmt: Statement, command: string, cwd: string, targets: Map<string, string>): void {
  walkNode(stmt.command, command, cwd, targets);
  // Statement-level redirects (e.g. a heredoc attached to the whole statement)
  // attribute to the statement's own source text.
  const source = command.slice(stmt.pos, stmt.end);
  for (const r of stmt.redirects) walkRedirect(r, cwd, source, command, targets);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract every escaping-looking path a bash command appears to reach OUTSIDE
 * cwd, each paired with the leaf command (`source`) that produced it.
 *
 * Pure extraction: returns candidates without judging allow/deny (that is the
 * PathManager's job). Heuristic — see module doc for blind spots.
 */
export function extractBashTargetsDetailed(command: string, cwd: string): ExtractedTarget[] {
  const targets = new Map<string, string>(); // path → source (first-write-wins)
  let ast: Script;
  try {
    ast = parse(command);
  } catch {
    return []; // unbash is best-effort and should not throw, but guard anyway.
  }
  walkScript(ast, command, cwd, targets);
  return [...targets.entries()].map(([path, source]) => ({ path, source: source || undefined }));
}

/** Path-only view of {@link extractBashTargetsDetailed} (for callers that only classify). */
export function extractBashTargets(command: string, cwd: string): string[] {
  return extractBashTargetsDetailed(command, cwd).map((t) => t.path);
}
