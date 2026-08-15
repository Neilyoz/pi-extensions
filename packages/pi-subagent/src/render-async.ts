/**
 * TUI rendering for background delegation: the background delegate input
 * block, the wait live view, and the check snapshot view.
 *
 * This module is deliberately independent of ./render.ts (the foreground
 * delegate family): the two presentation shapes evolve separately and share
 * only the pure helpers from ./utils.ts (per-item formatters, icons, the
 * result-line chain, and the elapsed-time timer).
 *
 * Layout contract (mirrors how foreground delegate rows decompose):
 * - background delegate row = INPUT only (static — the run outlives the call)
 * - wait row = per-run STATUS line + PROCESS stream + usage bar. When a run
 *   finishes, its result line carries only the status ("finished" / stop
 *   reason) — the conclusion itself is check's job, for the LLM and the user
 * - check row = the same block shape, but the single-run snapshot whose result
 *   line/expanded view DO show the actual output (check is the result-fetcher)
 *
 * Icon discipline (parity with the foreground row): the status line shows an
 * icon only while queued/running; once terminal it goes bare and the result
 * line takes over the icon — never both.
 */

import { getMarkdownTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type {
  BackgroundDelegateDetails,
  CheckDetails,
  RunViewEntry,
  SubagentResult,
  WaitDetails,
} from "./types.ts";
import {
  buildDisplayItems,
  clearElapsedTimer,
  contentText,
  deriveRunState,
  ensureElapsedTimer,
  formatFallback,
  formatThinking,
  formatTimePart,
  formatToolCall,
  formatUsageStats,
  renderDisplayItems,
  runIcon,
  statusStyle,
  taskPreview,
  terminalResultLine,
} from "./utils.ts";

// Contextual types derived from ToolDefinition so we don't depend on
// non-root-exported render types (ToolRenderContext is internal).
type RenderCallFn = NonNullable<ToolDefinition["renderCall"]>;
type RenderResultFn = NonNullable<ToolDefinition["renderResult"]>;

type Fg = (color: string, text: string) => string;

// ── Small shared pieces (same presentation family) ─────────────

/** Usage line: elapsed/budget(+grace) prefix + token/turn/cost stats. */
function runUsageLine(r: SubagentResult): string | null {
  const stats = formatUsageStats(r.usage, r.model);
  return [formatTimePart(r), stats].filter(Boolean).join(" \u00b7 ") || null;
}

/** Full activity stream as container rows (shared by the expanded views). */
function addActivityRows(container: Container, r: SubagentResult, fg: Fg): void {
  const activity = buildDisplayItems(r.activityLog);
  if (activity.length === 0) {
    const state = deriveRunState(r);
    const label =
      state === "queued" ? "(queued — waiting for a concurrency slot...)" : "(no activity yet)";
    container.addChild(new Text(fg("muted", label), 0, 0));
    return;
  }
  for (const item of activity) {
    if (item.type === "thinking") {
      container.addChild(new Text(formatThinking(item.status, fg), 0, 0));
    } else {
      const { prefix, color } = statusStyle(item.status, fg);
      container.addChild(new Text(prefix + formatToolCall(item.name, item.args, color), 0, 0));
    }
  }
}

/** Fallback trace line, shown while a retry is in flight and after it lands. */
function addFallbackRow(container: Container, r: SubagentResult, fg: Fg): void {
  if (r.fallbackFrom) {
    container.addChild(new Text(fg("warning", `\u26a0 fallback: ${formatFallback(r.fallbackFrom)}`), 0, 0));
  }
}

// ── wait entries: id'd status line, process stream, status-only result line ──

/** wait status line: `<icon> <id> (running|queued) <preview>` live; bare `<id> <preview>` once terminal. */
function waitStatusLine(entry: RunViewEntry, fg: Fg): string {
  const r = entry.result;
  const state = deriveRunState(r);
  if (state === "queued" || state === "running") {
    const label = state === "queued" ? "(queued)" : "(running)";
    return `${runIcon(r, fg)} ${fg("accent", entry.id)} ${fg("dim", label)} ${fg("text", taskPreview(r.task))}`;
  }
  // Terminal: no icon — the result line takes over the status display.
  return `${fg("accent", entry.id)} ${fg("text", taskPreview(r.task))}`;
}

function waitEntryCollapsedText(entry: RunViewEntry, fg: Fg): string {
  const r = entry.result;
  const state = deriveRunState(r);
  let text = waitStatusLine(entry, fg);

  if (state === "running") {
    const activity = buildDisplayItems(r.activityLog);
    if (activity.length === 0) {
      text += `\n${fg("muted", "(running...)")}`;
    } else {
      const rendered = renderDisplayItems(activity, 5, fg);
      if (rendered) text += `\n${rendered}`;
    }
  } else if (state !== "queued") {
    // The process stream becomes the result line once the run finishes.
    // "finished" — wait never shows output; the conclusion is check's job.
    text += `\n${terminalResultLine(r, fg, "finished")}`;
  }

  const usage = runUsageLine(r);
  if (usage) text += `\n${fg("dim", usage)}`;
  return text;
}

function waitEntryExpandedContainer(entry: RunViewEntry, fg: Fg): Container {
  const r = entry.result;
  const state = deriveRunState(r);
  const container = new Container();

  container.addChild(new Text(waitStatusLine(entry, fg), 0, 0));
  addFallbackRow(container, r, fg);
  container.addChild(new Spacer(1));
  if (state === "succeeded" || state === "failed") {
    container.addChild(new Text(terminalResultLine(r, fg, "finished"), 0, 0));
    container.addChild(new Spacer(1));
  }
  // Process stream in full — no output text here even when finished.
  addActivityRows(container, r, fg);

  const usage = runUsageLine(r);
  if (usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(fg("dim", usage), 0, 0));
  }
  return container;
}

// ── check entry: no id (single run), result line + expanded view show output ──

/** check status line: `<icon> (running|queued) <preview>` live; bare `<preview>` once terminal. No id — there is only one. */
function checkStatusLine(r: SubagentResult, fg: Fg): string {
  const state = deriveRunState(r);
  if (state === "queued" || state === "running") {
    const label = state === "queued" ? "(queued)" : "(running)";
    return `${runIcon(r, fg)} ${fg("dim", label)} ${fg("text", taskPreview(r.task))}`;
  }
  // Terminal: no icon — the result line takes over the status display.
  return fg("text", taskPreview(r.task));
}

function checkEntryCollapsedText(r: SubagentResult, fg: Fg): string {
  const state = deriveRunState(r);
  let text = checkStatusLine(r, fg);

  if (state === "running") {
    const activity = buildDisplayItems(r.activityLog);
    if (activity.length === 0) {
      text += `\n${fg("muted", "(running...)")}`;
    } else {
      const rendered = renderDisplayItems(activity, 5, fg);
      if (rendered) text += `\n${rendered}`;
    }
  } else if (state !== "queued") {
    // check is the result-fetcher: same chain as the foreground row.
    text += `\n${terminalResultLine(r, fg)}`;
  }

  const usage = runUsageLine(r);
  if (usage) text += `\n${fg("dim", usage)}`;
  return text;
}

function checkEntryExpandedContainer(r: SubagentResult, fg: Fg): Container {
  const state = deriveRunState(r);
  const container = new Container();

  container.addChild(new Text(checkStatusLine(r, fg), 0, 0));
  addFallbackRow(container, r, fg);
  container.addChild(new Spacer(1));

  if (state === "succeeded" || state === "failed") {
    container.addChild(new Text(terminalResultLine(r, fg), 0, 0));
    // check is the result-fetcher: the full output lives here.
    container.addChild(new Spacer(1));
    if (r.output.trim()) {
      container.addChild(new Markdown(r.output.trim(), 0, 0, getMarkdownTheme()));
      if (r.outputMethod === "compressed") {
        container.addChild(
          new Text(fg("muted", "(output compressed by summary model \u2014 full text in history)"), 0, 0),
        );
      } else if (r.outputMethod === "truncated") {
        container.addChild(new Text(fg("muted", "(output truncated \u2014 full text in history)"), 0, 0));
      }
    } else {
      container.addChild(new Text(fg("muted", "(no output \u2014 the run produced no text)"), 0, 0));
    }
  } else {
    addActivityRows(container, r, fg);
  }

  const usage = runUsageLine(r);
  if (usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(fg("dim", usage), 0, 0));
  }
  return container;
}

// ── Background delegate: static input block ────────────────────

export const renderBackgroundDelegateCall: RenderCallFn = (args, theme) => {
  const roleName = (args as any).role || "...";
  const text =
    theme.fg("toolTitle", theme.bold("subagent_delegate ")) +
    theme.fg("accent", roleName) +
    theme.fg("dim", " (background)");
  return new Text(text, 0, 0);
};

export const renderBackgroundDelegateResult: RenderResultFn = (result, { expanded }, theme) => {
  const details = result.details as BackgroundDelegateDetails | undefined;
  if (!details) return new Text(contentText(result), 0, 0);

  const fg = theme.fg.bind(theme) as Fg;
  // One-line anchor: marker + id + task preview. The run's live state is NOT
  // shown here — the row is written the moment the tool returns and the run
  // progresses invisibly until a wait/check row picks it up.
  const summaryLine = `${fg("accent", "\u25B6")} ${fg("dim", details.id)} ${fg("text", taskPreview(details.task))}`;

  if (!expanded) return new Text(summaryLine, 0, 0);

  // Expanded: full input — reference files, context size, task text.
  const container = new Container();
  container.addChild(new Text(summaryLine, 0, 0));
  container.addChild(new Spacer(1));
  if (details.files) {
    for (const f of details.files) {
      container.addChild(new Text(fg("dim", `@${f}`), 0, 0));
    }
  }
  if (details.context) {
    container.addChild(new Text(fg("dim", `ctx ${details.context.length} chars`), 0, 0));
  }
  container.addChild(new Text(fg("dim", details.task), 0, 0));
  return container;
};

// ── wait: live multi-run view ──────────────────────────────────

export const renderWaitCall: RenderCallFn = (args, theme) => {
  const ids = ((args as any).ids as string[] | undefined) ?? [];
  const label = ids.length > 0 ? ids.join(", ") : "(all)";
  const text = theme.fg("toolTitle", theme.bold("subagent_wait ")) + theme.fg("accent", label);
  return new Text(text, 0, 0);
};

export const renderWaitResult: RenderResultFn = (result, { expanded }, theme, context) => {
  const details = result.details as WaitDetails | undefined;
  if (!details || details.entries.length === 0) {
    return new Text(contentText(result), 0, 0);
  }

  // Tick while any watched run is still live. A timed-out wait freezes the
  // view instead — the runs keep going, but this row is done.
  const anyLive =
    !details.timedOut &&
    details.entries.some((e) => {
      const s = deriveRunState(e.result);
      return s === "queued" || s === "running";
    });
  if (anyLive) {
    ensureElapsedTimer(context);
  } else {
    clearElapsedTimer(context);
  }

  const fg = theme.fg.bind(theme) as Fg;

  if (expanded) {
    const container = new Container();
    details.entries.forEach((entry, i) => {
      if (i > 0) container.addChild(new Spacer(1));
      container.addChild(waitEntryExpandedContainer(entry, fg));
    });
    return container;
  }

  const text = details.entries.map((e) => waitEntryCollapsedText(e, fg)).join("\n\n");
  return new Text(text, 0, 0);
};

// ── check: frozen single-run snapshot ──────────────────────────

export const renderCheckCall: RenderCallFn = (args, theme) => {
  const id = (args as any).id || "...";
  const text = theme.fg("toolTitle", theme.bold("subagent_check ")) + theme.fg("accent", id);
  return new Text(text, 0, 0);
};

export const renderCheckResult: RenderResultFn = (result, { expanded }, theme, _context) => {
  const details = result.details as CheckDetails | undefined;
  if (!details) return new Text(contentText(result), 0, 0);

  const fg = theme.fg.bind(theme) as Fg;
  // Static snapshot — never starts the animation timer (the execute layer
  // freezes the frame before handing it over).
  if (expanded) return checkEntryExpandedContainer(details.result, fg);
  return new Text(checkEntryCollapsedText(details.result, fg), 0, 0);
};
