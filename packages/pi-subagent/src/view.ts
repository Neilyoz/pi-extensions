/**
 * /subagent:view — live activity overlay for subagent runs.
 *
 * Design: a continuous, append-only list. Every entry is static text plus a
 * state bit; the only animated thing is the ellipsis on a running entry's
 * suffix ("." → ".." → "..."). Finishing freezes an entry in place — its
 * position never changes, only the icon flips. Multiple runs stack: one
 * header line per run, entries flowing beneath it; concurrent tool calls are
 * adjacent spinning lines. Streamed assistant text is the single growing
 * element: it renders as the run's last line and freezes at message_end.
 *
 * Layout: a centered screen overlay (overlay:true) occupying most of the
 * terminal, framed with a thin border. An embedded Editor accepts steering
 * input for the focused run (Tab cycles targets); Enter queues the message
 * through the run's RPC stdin channel — delivered after the child's current
 * tool batch, before its next LLM call.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type Component,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { RunHandle } from "./run.ts";
import type { ActivityEntry } from "./types.ts";
import {
  formatThinking,
  formatTimePart,
  formatToolCall,
  formatUsageStats,
  runIcon,
  statusStyle,
  taskPreview,
} from "./utils.ts";

/** Max body lines kept visible; older entries roll off the top. */
const VIEWPORT_LINES = 26;
/** Animation tick for the running-entry ellipsis. */
const ANIMATION_INTERVAL_MS = 150;

type TuiLike = { requestRender(): void };
type Fg = (color: string, text: string) => string;

/** Pad a string with trailing spaces to a visible width (left-justified). */
function padRight(s: string, width: number): string {
  const v = visibleWidth(s);
  return v >= width ? s : s + " ".repeat(width - v);
}

/** Animated ellipsis suffix for running entries: ".", "..", "..." cycling. */
function dots(): string {
  return ".".repeat(1 + (Math.floor(Date.now() / 300) % 3));
}

/**
 * Build the display list of runs for the panel: running/queued first, then
 * finished, each group ordered by registry id.
 */
export function sortViewRuns(runs: RunHandle[]): RunHandle[] {
  const rank = (r: RunHandle) => (r.state === "running" || r.state === "queued" ? 0 : 1);
  return [...runs].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export class SubagentViewPanel implements Component, Focusable {
  focused = true;

  private runsProvider: () => RunHandle[];
  private theme: Theme;
  private tui: TuiLike;
  private close: () => void;
  private editor: Editor;
  /** Focused run (Tab cycles); the whole viewport belongs to it. */
  private focusIndex = 0;
  /** Transient feedback line ("steer sent to sub-N"), auto-clears. */
  private flash = "";
  private flashUntil = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    runsProvider: () => RunHandle[],
    tui: TuiLike,
    theme: Theme,
    onClose: () => void,
  ) {
    this.runsProvider = runsProvider;
    this.tui = tui;
    this.theme = theme;
    this.close = onClose;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    this.editor = new Editor(tui as never, editorTheme);
    this.editor.onSubmit = (value) => this.submitSteer(value);

    // Drive the ellipsis animation while the panel is open.
    this.timer = setInterval(() => {
      try {
        this.tui.requestRender();
      } catch {
        /* ignore */
      }
    }, ANIMATION_INTERVAL_MS);
  }

  private focusedRun(): RunHandle | undefined {
    const runs = sortViewRuns(this.runsProvider());
    if (runs.length === 0) return undefined;
    if (this.focusIndex >= runs.length) this.focusIndex = 0;
    return runs[this.focusIndex];
  }

  private submitSteer(value: string): void {
    const text = value.trim();
    if (!text) return;
    const target = this.focusedRun();
    if (!target || target.state !== "running") {
      this.showFlash("focused run is not running — nothing to steer");
      return;
    }
    target.steer(text);
    this.editor.setText("");
    this.showFlash(`steer queued for ${target.id} (${target.role})`);
  }

  private showFlash(message: string): void {
    this.flash = message;
    this.flashUntil = Date.now() + 3000;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.closePanel();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      const n = sortViewRuns(this.runsProvider()).length;
      if (n > 1) {
        this.focusIndex = (this.focusIndex + 1) % n;
        this.tui.requestRender();
      }
      return;
    }
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  private closePanel(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.close();
  }

  /** Render one activity entry as a static line; running entries get the
   *  animated ellipsis suffix. */
  private renderEntry(e: ActivityEntry, width: number, fg: Fg): string {
    const indent = "  ";
    if (e.kind === "thinking") {
      if (e.status === "running") {
        return truncateToWidth(indent + fg("accent", `◇ thinking${dots()}`), width);
      }
      return truncateToWidth(indent + formatThinking(e.status, fg), width);
    }
    if (e.kind === "steer") {
      const firstLine = (e.text ?? "").trimEnd().split("\n")[0] || "";
      return truncateToWidth(indent + fg("accent", `↩ steer: ${firstLine}`), width);
    }
    if (e.kind === "text") {
      const buffer = e.text ?? "";
      const lastLine = buffer.trimEnd().split("\n").pop() ?? "";
      const body = lastLine || "…";
      if (e.status === "running") {
        return truncateToWidth(indent + fg("accent", `¶ ${body}${dots()}`), width);
      }
      // Frozen: no ANSI at all — same plain terminal foreground as the main
      // UI's output text (theme "text" is a grey var, not the default fg).
      return truncateToWidth(indent + `¶ ${body}`, width);
    }
    const { prefix, color } = statusStyle(e.status, fg);
    const suffix = e.status === "running" ? fg("accent", ` ${dots()}`) : "";
    const line = prefix + formatToolCall(e.toolName ?? "?", e.args ?? {}, color) + suffix;
    return truncateToWidth(indent + line, width);
  }

  render(width: number): string[] {
    const th = this.theme;
    // Same adaptation render.ts uses: utils formatters take a loose Fg.
    const fg = th.fg.bind(th) as unknown as Fg;
    // Border frame: inner content lives at width-2.
    const innerW = Math.max(20, width - 2);
    const row = (content: string) => {
      const fitted = truncateToWidth(content, innerW);
      return th.fg("border", "│") + padRight(fitted, innerW) + th.fg("border", "│");
    };

    const runs = sortViewRuns(this.runsProvider());
    const lines: string[] = [];

    const runningCount = runs.filter((r) => r.state === "running").length;

    // ── Tab row: one cell per run; the focused one is highlighted. ──
    if (runs.length > 0) {
      const cells = runs.map((r, i) => {
        const focused = r === this.focusedRun();
        const label = `${runIcon(r.snapshot, fg)} ${r.id} ${r.role}`;
        const styled = focused ? th.bg("selectedBg", fg("accent", label)) : fg("dim", label);
        return focused ? styled : `[${styled}]`;
      });
      lines.push(
        row(
          `${fg("accent", th.bold("subagents"))} ${th.fg("dim", `${runningCount} running · ${runs.length} total · Tab switch`)}  ` +
            cells.join(th.fg("dim", " ")),
        ),
      );
    } else {
      lines.push(row(fg("muted", "subagents: no runs.")));
    }

    // ── Focused run: full viewport, tail-capped entries. ──
    // Reserve room for tab row (1) + steer bar (2) + hint (1).
    const budget = Math.max(3, VIEWPORT_LINES - 4);
    const run = this.focusedRun();
    if (run) {
      const snap = run.snapshot;
      const icon = runIcon(snap, fg);
      const time = formatTimePart({ ...snap, exitCode: run.state === "queued" ? -1 : snap.exitCode });
      const parts = [
        `${icon} ${fg("accent", th.bold(run.id))}`,
        fg("text", run.role),
        fg("dim", taskPreview(run.task)),
        time ? fg("dim", time) : "",
        fg("dim", formatUsageStats(snap.usage, snap.model)),
      ].filter(Boolean);
      lines.push(row(parts.join(th.fg("dim", " · "))));
      const entries = snap.activityLog.map((entry) => this.renderEntry(entry, innerW, fg));
      if (entries.length > budget) {
        entries.splice(0, entries.length - budget);
        lines.push(row(fg("muted", "⋮ earlier activity")));
      }
      for (const ln of entries.slice(0, budget)) lines.push(row(ln));
    }

    // ── Steer bar ──
    if (Date.now() < this.flashUntil) {
      lines.push(row(fg("success", this.flash)));
    } else {
      const target = run && run.state === "running" ? `${run.id} (${run.role})` : null;
      const label = target
        ? fg("accent", target)
        : fg("dim", run ? `${run.id} not running` : "no runs");
      lines.push(row(fg("dim", `steer → ${label}`)));
    }
    for (const el of this.editor.render(innerW)) {
      lines.push(row(el));
    }
    lines.push(row(fg("dim", "Enter steer · Tab switch run · Esc close")));

    // Frame.
    return [
      th.fg("border", `╭${"─".repeat(innerW)}╮`),
      ...lines,
      th.fg("border", `╰${"─".repeat(innerW)}╯`),
    ];
  }

  invalidate(): void {}
}

/** Wire the panel to the overlay lifecycle: the animation timer dies with the panel. */
export function createViewPanel(
  runsProvider: () => RunHandle[],
  tui: TuiLike,
  theme: Theme,
  onClose: () => void,
): SubagentViewPanel {
  return new SubagentViewPanel(runsProvider, tui, theme, onClose);
}
