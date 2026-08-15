/**
 * Pure helpers for pi-subagent: formatting, sanitization, and the concurrency
 * semaphore. No pi-API or I/O dependencies — safe to unit-test.
 */

import * as os from "node:os";
import type {
  ActivityEntry,
  FallbackFrom,
  RunState,
  SubagentDetails,
  SubagentRole,
  SubagentResult,
  SubagentUsage,
  ToolStatus,
  WaitDetails,
} from "./types.ts";

/** Max output chars fed to the main model and the expanded TUI. Larger outputs are compressed (or truncated) to fit. */
export const MAX_OUTPUT_CHARS = 50_000;

/** Coalesce bursty progress events so the TUI repaints at most this often. */
export const PROGRESS_THROTTLE_MS = 50;

/** A zeroed usage block — frames and synthesized failures start from this. */
export function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: SubagentResult["usage"], model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`\u2191${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`\u2193${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * Display elapsed time in seconds.
 * - Running (exitCode === -1 with startTime): live wall-clock value.
 * - Terminal (exitCode !== -1 with elapsedMs): frozen value.
 * - Queued or fields missing: undefined (caller should skip the elapsed display).
 *
 * Takes a structural subset rather than the full SubagentResult so it can be reused
 * and tested in pure-helper contexts without importing the full type.
 */
export function elapsedSeconds(r: {
  exitCode: number;
  startTime?: number;
  elapsedMs?: number;
}): number | undefined {
  if (r.exitCode === -1 && typeof r.startTime === "number") {
    return Math.max(0, Math.round((Date.now() - r.startTime) / 1000));
  }
  if (r.exitCode !== -1 && typeof r.elapsedMs === "number") {
    return Math.round(r.elapsedMs / 1000);
  }
  return undefined;
}

export type DisplayItem =
  | { type: "toolCall"; name: string; args: Record<string, any>; status?: ToolStatus }
  | { type: "thinking"; status?: ToolStatus };

/** Map the real-time activity log into renderable display items (in order). */
export function buildDisplayItems(activityLog: ActivityEntry[]): DisplayItem[] {
  return activityLog.map((a) =>
    a.kind === "thinking"
      ? { type: "thinking", status: a.status }
      : { type: "toolCall", name: a.toolName ?? "?", args: a.args ?? {}, status: a.status },
  );
}

export function shortenPath(p: string): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    return p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
  }
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  fg: (color: string, text: string) => string,
): string {
  switch (toolName) {
    case "subagent_delegate": {
      const subRole = args.role as string | undefined;
      // Compact display label — the full tool name is subagent_delegate.
      return fg("muted", "delegate ") + fg("accent", subRole ?? "...");
    }
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return fg("muted", "$ ") + fg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = fg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return fg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = fg("muted", "write ") + fg("accent", shortenPath(rawPath));
      if (lines > 1) text += fg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        fg("muted", "grep ") +
        fg("accent", `/${pattern}/`) +
        fg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      return fg("muted", "find ") + fg("accent", pattern);
    }
    case "glob": {
      const pattern = (args.pattern || "*") as string;
      return fg("muted", "glob ") + fg("accent", pattern);
    }
    default: {
      const preview = previewArgs(args);
      return fg("accent", toolName) + (preview ? fg("dim", ` ${preview}`) : "");
    }
  }
}

/** Per-tool-call visual styling: prefix glyph + color function keyed by status. */
export function statusStyle(
  status: ToolStatus | undefined,
  fg: (color: string, text: string) => string,
): { prefix: string; color: (c: string, text: string) => string } {
  switch (status) {
    case "running":
      return { prefix: fg("accent", "\u2192 "), color: fg };
    case "failed":
      return { prefix: fg("error", "\u2717 "), color: (_c, text) => fg("error", text) };
    case "done":
    default:
      return { prefix: fg("dim", "\u2022 "), color: (_c, text) => fg("dim", text) };
  }
}

/** Render a thinking-block row: diamond glyph + label, colored by status.
 * Running = hollow diamond (unformed thought); done = solid diamond (settled). */
export function formatThinking(
  status: ToolStatus | undefined,
  fg: (color: string, text: string) => string,
): string {
  if (status === "running") {
    return fg("accent", "\u25C7 thinking");
  }
  // done (or unknown) — dim past tense, solid diamond
  return fg("dim", "\u25C6 thought");
}

export function renderDisplayItems(
  items: DisplayItem[],
  limit: number | undefined,
  fg: (color: string, text: string) => string,
): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += fg("muted", `... ${skipped} earlier items\n`);
  for (const item of toShow) {
    if (item.type === "thinking") {
      text += `${formatThinking(item.status, fg)}\n`;
    } else {
      const { prefix, color } = statusStyle(item.status, fg);
      text += `${prefix}${formatToolCall(item.name, item.args, color)}\n`;
    }
  }
  return text.trimEnd();
}

export function isFailedResult(r: { exitCode: number; stopReason?: string }): boolean {
  return (
    r.exitCode !== 0 ||
    r.stopReason === "error" ||
    r.stopReason === "aborted" ||
    r.stopReason === "timeout"
  );
}

export function hasFailedSubagentResult(details: unknown): boolean {
  const d = details as SubagentDetails | undefined;
  return Array.isArray(d?.results) && d.results.some(isFailedResult);
}

/** Provider-error keywords that make a failed run worth retrying on the fallback role. */
const PROVIDER_ERROR_RE =
  /429|quota|rate.?limit|auth|timeout|exhausted|unavailable|503|server error|temporary|declined|overloaded|econnreset|socket hang up|epipe|network|connection/i;

/** Heuristic: does this result look like a provider-side failure worth retrying on the fallback role? */
export function isProviderError(result: SubagentResult): boolean {
  return PROVIDER_ERROR_RE.test(`${result.stderr || ""}\n${result.errorMessage || ""}`);
}

/** Cap for the stderr tail kept in fallback diagnostics. */
export const FALLBACK_STDERR_TAIL = 400;

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Best-effort diagnosis from stderr when the child died before any message_end
 * (e.g. 429 on the very first request — model/errorMessage/stopReason all unset).
 * Returns the last stderr line mentioning a provider-error keyword: pi prints
 * the fatal error near exit, so the last match is the most specific.
 */
export function extractProviderReason(text: string): string | undefined {
  const lines = text
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROVIDER_ERROR_RE.test(lines[i])) return lines[i];
  }
  return undefined;
}

/**
 * Snapshot a failed first attempt for fallback observability.
 * The fallback retry overwrites the result, so this snapshot is the only
 * trace of why the first attempt died. stderr is noisy (TUI teardown
 * escape sequences) — only a truncated tail is kept.
 *
 * `requestedModel` fills the model field when the child died before any
 * message_end — the parent always knows what it asked for.
 */
export function buildFallbackFrom(first: SubagentResult, requestedModel?: string): FallbackFrom {
  const tail = first.stderr.slice(-FALLBACK_STDERR_TAIL).trim();
  return {
    model: first.model ?? requestedModel,
    stopReason: first.stopReason,
    errorMessage: first.errorMessage || extractProviderReason(tail),
    stderrTail: tail || undefined,
  };
}

/**
 * One-line human-readable fallback reason, e.g.
 * `first attempt deepseek-v4-flash failed (Timed out after 900s)`.
 * Prefer errorMessage; fall back to stopReason, else a generic label.
 */
export function formatFallback(f: FallbackFrom): string {
  const reason = f.errorMessage || f.stopReason || "provider error";
  const firstLine = reason.split("\n")[0];
  const short = firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
  return `first attempt ${f.model ?? "unknown model"} failed (${short})`;
}

// ── Background runs (delegate background:true / wait / check) ────────────

/** Derive the lifecycle state of a run from one of its frames (live or terminal). */
export function deriveRunState(r: { exitCode: number; queued?: boolean; stopReason?: string }): RunState {
  if (r.exitCode === -1) return r.queued ? "queued" : "running";
  return isFailedResult(r) ? "failed" : "succeeded";
}

/** True when wait tool result details carries the timeout flag. */
export function isWaitTimedOut(details: unknown): boolean {
  return (details as WaitDetails | undefined)?.timedOut === true;
}

/** Human-readable description of what a running subagent is doing right now (latest activity item). */
export function describeCurrentActivity(r: { activityLog: ActivityEntry[] }): string {
  const last = r.activityLog[r.activityLog.length - 1];
  if (!last) return "waiting for first event";
  if (last.kind === "thinking") return last.status === "running" ? "thinking" : "thought";
  return formatToolCall(last.toolName ?? "?", last.args ?? {}, (_color, text) => text);
}

/** Footer appended to terminal results for the main model: `\n\n--- 3 turns ↑12k ↓1k $0.01 model ---` (empty when nothing to show). */
export function formatUsageFooter(r: { usage: SubagentUsage; model?: string }): string {
  const parts: string[] = [];
  if (r.usage.turns) parts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
  if (r.usage.input) parts.push(`\u2191${formatTokens(r.usage.input)}`);
  if (r.usage.output) parts.push(`\u2193${formatTokens(r.usage.output)}`);
  if (r.usage.cost) parts.push(`$${r.usage.cost.toFixed(4)}`);
  if (r.model) parts.push(r.model);
  return parts.length > 0 ? `\n\n--- ${parts.join(" ")} ---` : "";
}

/** Fallback provenance note appended to terminal results (empty when no retry happened). */
export function formatFallbackNote(r: { fallbackFrom?: FallbackFrom; model?: string }): string {
  return r.fallbackFrom
    ? `\n\n--- fallback: ${formatFallback(r.fallbackFrom)}; retried on ${r.model ?? "fallback role"} ---`
    : "";
}

/** LLM-facing text returned by the check tool for one run snapshot. */
export function formatCheckText(id: string, role: string, r: SubagentResult): string {
  const state = deriveRunState(r);
  const head = `${id} (${role})`;
  if (state === "queued") return `${head}: queued — waiting for a concurrency slot.`;
  if (state === "running") return `${head}: running — ${describeCurrentActivity(r)}`;
  if (state === "failed") {
    return `${head}: failed — ${r.errorMessage || r.stderr || "unknown error"}\n\nPartial output:\n${r.output}`;
  }
  return `${head}: finished\n\n${r.output}${formatFallbackNote(r)}${formatUsageFooter(r)}`;
}

/** Freeze a live frame into a static snapshot: stop the elapsed clock and fold the open pause into grace. */
export function freezeFrame(r: SubagentResult): SubagentResult {
  return {
    ...r,
    startTime: undefined,
    elapsedMs: r.startTime ? Date.now() - r.startTime : r.elapsedMs,
    graceMs: (r.graceMs ?? 0) + (r.pauseStart ? Date.now() - r.pauseStart : 0),
    pauseStart: undefined,
  };
}

/**
 * Shape-based preview for tools we don't have a dedicated formatter for.
 * @internal — exported for testing; used internally by {@link formatToolCall}.
 */
export function previewArgs(args: Record<string, unknown>): string {
  const command = args.command as string | undefined;
  if (command) return `$ ${command.length > 60 ? command.slice(0, 60) + "..." : command}`;
  const fp = (args.file_path || args.path) as string | undefined;
  if (fp) return shortenPath(fp);
  const url = args.url as string | undefined;
  if (url) return url.length > 60 ? url.slice(0, 60) + "..." : url;
  const query = (args.query || args.pattern || args.regex || args.search) as string | undefined;
  if (query) return `/${query.length > 60 ? query.slice(0, 60) + "..." : query}/`;
  const argsStr = JSON.stringify(args);
  return argsStr.length > 50 ? argsStr.slice(0, 50) + "..." : argsStr;
}

// ── Numeric configuration ─────────────────────────────────────

/** Normalize a finite numeric limit: invalid values use the default; negatives become 0 (unlimited). */
export function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/** Normalize a count limit to a non-negative integer. */
export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  return Math.floor(normalizeNonNegativeNumber(value, fallback));
}

// ── Concurrency gate ───────────────────────────────────────────────

/**
 * Promise-based semaphore capping concurrent subagent spawns.
 * A max of 0 means unlimited concurrency, so acquire() never queues.
 * Pass an AbortSignal to cancel while waiting (rejects and removes the waiter).
 */
export class AsyncSemaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  private max: number;
  constructor(max: number) {
    this.max = normalizeNonNegativeInteger(max, 0);
  }
  get isLimited(): boolean {
    return this.max > 0;
  }
  get isAtCapacity(): boolean {
    return this.isLimited && this.active >= this.max;
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    if (!this.isAtCapacity) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const wakeup = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        const idx = this.waiters.indexOf(wakeup);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("aborted while waiting for concurrency slot"));
      };
      this.waiters.push(wakeup);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  release(): void {
    this.active = Math.max(0, this.active - 1);
    if (!this.isLimited) return;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ── Timeout policy ────────────────────────────────────────

/**
 * Effective per-role timeout in SECONDS (convert to ms at the spawn boundary).
 * `0` or unset means unlimited; non-finite and negative values normalize to 0.
 */
export function effectiveTimeout(roleDef: SubagentRole): number {
  return normalizeNonNegativeNumber(roleDef.timeout, 0);
}

// ── Output truncation ────────────────────────────────────────

/** Strip path separators / traversal so sessionId/toolCallId can't escape the history dir. */
export function sanitizeFilename(s: string): string {
  return s.replace(/[^\w.-]/g, "_").replace(/^[.]+/, "") || "unknown";
}

/** Mechanical fallback: keep head (findings) + tail (summary), drop the middle. */
export function truncateOutput(t: string): string {
  const head = t.slice(0, 30_000);
  const tail = t.slice(-(MAX_OUTPUT_CHARS - 30_050));
  return `[Output truncated — ${t.length} chars total]\n\n${head}\n\n... [truncated] ...\n\n${tail}`;
}
