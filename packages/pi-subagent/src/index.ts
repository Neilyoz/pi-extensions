/**
 * pi-subagent — Role-based subagent orchestration with TUI rendering.
 *
 * Delegates tasks to specialized pi child processes with:
 * - One shared async run engine (./run.ts): foreground delegation is
 *   background delegation that the tool call blocks on
 * - `subagent_delegate(background: true)` starts a run and returns an id
 *   immediately; `subagent_wait` blocks on ids, `subagent_check` fetches a
 *   one-shot snapshot/result
 * - Real-time progress streaming via TUI (tool calls, turns, elapsed time)
 * - AI-generated one-line summary for compact display (configurable role)
 * - Live activity log (thinking + tool calls) for the TUI, full output on completion
 * - Accurate, concise output for the main model
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type {
  CollectedRun,
  SubagentConfig,
  SubagentResult,
  SubagentRole,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { loadSubagentConfig } from "./config.ts";
import { BUILTIN_ROLES } from "./roles.ts";
import { getPiInvocation } from "./spawn.ts";
import {
  AsyncSemaphore,
  createThrottler,
  describeCurrentActivity,
  formatBudgetNote,
  formatCancelText,
  formatCheckText,
  formatFallbackNote,
  formatTimePart,
  formatUsageFooter,
  freezeFrame,
  hasFailedSubagentResult,
  isFailedResult,
  isWaitTimedOut,
  taskPreview,
} from "./utils.ts";
import { startSubagentRun, type RunHandle } from "./run.ts";
import { buildInboxReminder, injectReminder } from "./reminder.ts";
import { renderDelegateCall, renderDelegateResult } from "./render.ts";
import { createViewPanel } from "./view.ts";
import {
  renderBackgroundDelegateCall,
  renderBackgroundDelegateResult,
  renderCancelCall,
  renderCancelResult,
  renderCheckCall,
  renderCheckResult,
  renderWaitCall,
  renderWaitResult,
} from "./render-async.ts";

const BACKGROUND_COMPLETION_MESSAGE_TYPE = "subagent-completion";

// ── Extension entry ────────────────────────────────────────────────

export default function subagentExtension(pi: ExtensionAPI) {
  let config: SubagentConfig = DEFAULT_CONFIG;
  let concurrencyGate = new AsyncSemaphore(DEFAULT_CONFIG.maxConcurrency);

  // If spawned as a child by a parent subagent, PI_SUBAGENT_ALLOWED restricts
  // which roles are available. Filter before any tool description sees them.
  const ALLOWLIST: string[] | undefined = (() => {
    const raw = process.env.PI_SUBAGENT_ALLOWED;
    if (!raw) return undefined;
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  })();

  // Nesting depth: 0 in the top-level session, incremented via PI_SUBAGENT_DEPTH
  // for each child. Bounds how deeply subagents may spawn their own subagents.
  const CURRENT_DEPTH: number = (() => {
    const raw = process.env.PI_SUBAGENT_DEPTH;
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();

  const availableRoles: Record<string, SubagentRole> = {};
  // Rebuild available roles from BUILTIN_ROLES, filtered by the child
  // allowlist. Called at init and again in session_start so repeated
  // session_start is idempotent — overrides don't accumulate.
  function refreshAvailableRoles(): void {
    for (const key of Object.keys(availableRoles)) delete availableRoles[key];
    for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
      if (!ALLOWLIST || ALLOWLIST.includes(name)) {
        availableRoles[name] = role;
      }
    }
  }
  refreshAvailableRoles();

  // ── Background run registry ────────────────────────────────────
  // Process-lifetime map of unclaimed background runs (queued, running, and
  // finished/failed alike). Foreground delegate runs are NOT registered —
  // their lifecycle is the tool call itself. subagent_check on a terminal run
  // collects it: the handle is freed and a lightweight CollectedRun tombstone
  // takes its place, so ids stay resolvable while memory does not grow with
  // full results.
  const backgroundRuns = new Map<string, RunHandle>();
  const collectedRuns = new Map<string, CollectedRun>();
  let runCounter = 0;
  let sessionGeneration = 0;

  // ── Live-run reaping ─────────────────────────────────────────
  // Every in-flight run (foreground and background alike), removed once
  // settled. session_shutdown aborts whatever is still here so no child
  // process outlives the parent — quit, reload, or session replacement.
  const liveRuns = new Set<RunHandle>();
  function trackRun(run: RunHandle): void {
    liveRuns.add(run);
    void run.promise.then(() => liveRuns.delete(run));
  }

  // Mutable guidelines array — rebuilt in session_start to reflect agentOverrides
  const guidelines: string[] = [];

  function rebuildGuidelines(roles: Record<string, SubagentRole>): void {
    const entries = Object.entries(roles);
    const exampleLines: string[] = [];
    const decisionLines: string[] = [];

    for (const [name, role] of entries) {
      // Decision flow
      decisionLines.push(`  ${role.decisionTrigger} → subagent_delegate(${name})`);

      // Concrete examples — one line per role with comma-separated examples
      const quotedExamples = role.examples.map((e) => `"${e}"`).join(", ");
      exampleLines.push(`  subagent_delegate(${name}):  ${quotedExamples}`);
    }

    guidelines.length = 0;
    guidelines.push(
      "WHEN TO DELEGATE — offload substantial work when you only need the result:",
      "",
      "- Delegate ONLY when a task involves significant work (heavy analysis, multi-step investigation, large-scope changes) AND you only care about the conclusion, not intermediate steps. A good test: the task would clutter your context with 3+ turns of raw tool output.",
      "- DO NOT delegate simple tasks — a single read, a one-line edit, a basic grep, or straightforward changes touching 1-2 files. Just do them yourself; spawning a child process costs more than the task.",
      "",
      "AVAILABLE ROLES:",
      ...entries.map(([name, role]) => `  - ${name}: ${role.description}`),
      "",
      "DECISION FLOW (which role for what):",
      "",
      ...decisionLines,
      "",
      "CONCRETE EXAMPLES of good delegation targets:",
      "",
      ...exampleLines,
      "",
      "EXECUTION MODES:",
      "",
      "- Foreground (default): the call blocks until the run finishes and returns the final output directly.",
      "- Parallel: multiple subagent_delegate calls at the same time run concurrently — foreground and background alike, no special flag.",
      "- Background (background: true): non-blocking — returns an id immediately so you can do your own work while the run executes.",
      "",
      "BACKGROUND DELEGATION:",
      "",
      "- Use it only when you have your own work this turn (including an ongoing discussion with the user) while the run executes; otherwise let the call block and return the result directly.",
      "- Results are pull-only for the model — a completion notice is shown to the user, but nothing wakes you or delivers the result. Dispatching means owning the collection point: finish your own work, then subagent_check(id) for each result. Use subagent_wait(ids) to block until the run finish.",
      "- Cancel a run you no longer need with subagent_cancel(id) — the child stops and its partial output stays in the registry for subagent_check to collect.",
      "- Background delegation works only in the top-level session.",
    );
  }

  // Apply agent overrides on top of built-in roles
  function applyAgentOverrides(
    roles: Record<string, SubagentRole>,
    overrides: Record<string, Partial<SubagentRole> & { disabled?: boolean }>,
  ): void {
    for (const [name, override] of Object.entries(overrides)) {
      if (override.disabled) {
        delete roles[name];
      } else if (roles[name]) {
        roles[name] = { ...roles[name], ...override };
      } else {
        // Custom role — must provide all required fields (validated in session_start)
        roles[name] = override as SubagentRole;
      }
    }
  }

  // Initial guidelines from built-in roles
  rebuildGuidelines(availableRoles);

  pi.on("session_start", async (_event, ctx) => {
    sessionGeneration += 1;
    config = loadSubagentConfig(ctx.cwd);
    concurrencyGate = new AsyncSemaphore(config.maxConcurrency);

    refreshAvailableRoles();
    applyAgentOverrides(availableRoles, config.agentOverrides);

    // Validate custom roles (skip built-in roles — they already have all fields)
    // `tools` is optional — absent means the role gets all tools.
    const REQUIRED_FIELDS = [
      "role",
      "description",
      "examples",
      "decisionTrigger",
      "systemPrompt",
    ] as const;
    for (const [name, role] of Object.entries(availableRoles)) {
      if (name in BUILTIN_ROLES) continue;
      const missing = REQUIRED_FIELDS.filter((f) => !(f in (role as any)));
      if (missing.length > 0) {
        delete availableRoles[name];
        ctx.ui.notify(
          `[pi-subagent] Custom role "${name}" skipped — missing: ${missing.join(", ")}. Required: ${REQUIRED_FIELDS.join(", ")}.`,
          "error",
        );
      }
    }

    rebuildGuidelines(availableRoles);
  });

  pi.on("context", async (event) => {
    // Completion notices are persisted custom messages so the user can see
    // them in the transcript, but they are deliberately UI-only. Keep the
    // model on the reminder/check path instead of duplicating the notice in
    // its context.
    const messages = event.messages.filter(
      (message) =>
        message.role !== "custom" || message.customType !== BACKGROUND_COMPLETION_MESSAGE_TYPE,
    );

    // The model's inbox: every unclaimed background run, injected at a
    // cache-stable head position before every provider call. Empty inbox and
    // no filtered notices → context stays untouched, cache fully stable.
    const reminder = buildInboxReminder(backgroundRuns.values());
    if (!reminder && messages.length === event.messages.length) return;
    return { messages: reminder ? injectReminder(messages, reminder) : messages };
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "subagent_delegate" && hasFailedSubagentResult(event.details)) {
      return { isError: true };
    }
    if (event.toolName === "subagent_wait" && isWaitTimedOut(event.details)) {
      return { isError: true };
    }
  });

  // Fires before the extension runtime is torn down (quit, reload, or
  // session replacement). Aborting funnels through the standard abort path:
  // children get SIGTERM → their own handlers kill grandchildren, aborted
  // runs are audited to history, gates release. Without this, background
  // children would burn tokens as unwaitable orphans after /reload or /new.
  pi.on("session_shutdown", () => {
    sessionGeneration += 1;
    for (const run of liveRuns) run.abort("session shutdown");
  });

  pi.registerTool({
    name: "subagent_delegate",
    label: "Delegate to subagent",
    description:
      "Delegate a task to a specialized subagent. By default the call blocks until the run finishes and returns the final output — intermediate tool output stays out of your context. With background: true it returns an id immediately and you collect the result later with subagent_wait/subagent_check. Subagents have no access to this conversation — everything they need must arrive through the parameters.",
    promptSnippet: "Delegate tasks to specialized subagents",
    promptGuidelines: guidelines,

    parameters: Type.Object({
      role: Type.String({ description: "Subagent role to use" }),
      task: Type.String({
        description:
          "The work to do. Instructions only — background material belongs in `context`, reference file paths in `files`.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Background material for the subagent — prior findings, selected code, file lists; can be long. Delivered as a separate channel from the task. Omit if the task alone is enough.",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Reference file paths for the subagent to read directly (e.g. ["src/auth.ts", "docs/api.md"]). Injected as @file attachments — content stays out of your context window. Prefer this over pasting file contents into context.',
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Non-blocking: returns an id immediately so you can do your own work (or keep discussing with the user) while the run executes — not for parallelism (several foreground calls in one turn already run concurrently). Results are pull-only for the model: a completion notice is shown to the user, but nothing delivers the result or wakes you; fetch with subagent_wait/subagent_check when your own work is done. If the next thing you'd do is wait for the result, omit this and let the call block.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
      model: Type.Optional(
        Type.String({
          description:
            "Override the model for this call. Format: 'provider/model-id' (e.g. 'anthropic/claude-sonnet-4'). When set, bypasses the role's configured model — useful for one-off vision tasks or model-specific jobs without creating a permanent role.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const roleDef = availableRoles[params.role];
      if (!roleDef) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown subagent role: ${params.role}. Available: ${Object.keys(availableRoles).join(", ")}`,
            },
          ],
          details: undefined as any,
        };
      }

      // Guard against bounded subagent nesting. A configured depth of 0 is unlimited.
      if (config.maxDepth > 0 && CURRENT_DEPTH >= config.maxDepth) {
        throw new Error(
          `Cannot delegate: maximum nesting depth (${config.maxDepth}) reached (current depth ${CURRENT_DEPTH}). Return a result to the caller instead of delegating further.`,
        );
      }

      // A subagent process exits when its task finishes, which would orphan any
      // background run it started — background delegation is top-level only.
      if (params.background && CURRENT_DEPTH > 0) {
        throw new Error(
          "Background delegation is only available in the top-level session. Delegate in the foreground instead.",
        );
      }

      const run = startSubagentRun({
        id: `sub-${++runCounter}`,
        toolCallId: _toolCallId,
        role: params.role,
        roleDef,
        task: params.task,
        context: params.context,
        files: params.files,
        cwd: params.cwd ?? ctx.cwd,
        depth: CURRENT_DEPTH + 1,
        // Foreground runs die with the tool call; background runs outlive the turn.
        signal: params.background ? undefined : signal,
        modelOverride: params.model,
        config,
        gate: concurrencyGate,
        getRolesApi: getModelRolesAPI,
        getSessionId: () => ctx.sessionManager?.getSessionId(),
      });
      trackRun(run);

      // ── Background: return the id immediately; the pipeline keeps running. ──
      if (params.background) {
        backgroundRuns.set(run.id, run);
        const runGeneration = sessionGeneration;
        void run.promise.then((result) => {
          // A collected run already has a visible check result. Do not emit a
          // second notice, and never publish completions from an old session.
          if (!backgroundRuns.has(run.id) || runGeneration !== sessionGeneration) return;

          const outcome = isFailedResult(result)
            ? "failed"
            : result.stopReason === "cancelled"
              ? "cancelled"
              : "finished";
          const detail =
            outcome === "failed"
              ? result.errorMessage || result.stderr
              : outcome === "cancelled"
                ? result.errorMessage
                : result.summary;
          const detailText = detail?.trim() ? ` — ${taskPreview(detail)}` : "";
          pi.sendMessage(
            {
              customType: BACKGROUND_COMPLETION_MESSAGE_TYPE,
              content: `Background subagent ${run.id} (${run.role}) ${outcome}: "${taskPreview(run.task)}"${detailText}`,
              display: true,
              details: { id: run.id, role: run.role, outcome },
            },
            { triggerTurn: false },
          );
        });
        return {
          content: [
            { type: "text", text: `Background subagent started — id: ${run.id} (${params.role}).` },
          ],
          details: {
            id: run.id,
            role: params.role,
            task: params.task,
            context: params.context,
            files: params.files,
          },
        };
      }

      // ── Foreground: the same async engine, blocked on here. ──
      const emit = (results: SubagentResult[], text: string) => {
        onUpdate?.({
          content: [{ type: "text", text }],
          details: { results },
        });
      };
      const progressText = (f: SubagentResult): string =>
        `${params.role}  ${formatTimePart(f) ?? "0s"}  ${f.usage.turns} turn${f.usage.turns !== 1 ? "s" : ""}`;

      let pendingFrame: SubagentResult | undefined;
      const progressThrottle = createThrottler(() => {
        const f = pendingFrame;
        pendingFrame = undefined;
        if (f) emit([f], progressText(f));
      });

      const unsubscribe = run.subscribe(() => {
        if (run.result) return; // the terminal frame is emitted explicitly below
        if (!onUpdate) return;
        pendingFrame = run.snapshot;
        progressThrottle.notify();
      });

      // Emit a queued placeholder only when this call will actually wait.
      if (onUpdate && concurrencyGate.isAtCapacity) {
        emit([run.snapshot], `${params.role}: queued...`);
      }

      try {
        const result = await run.promise;

        // Fallback note: the main model must know the answer came from the
        // fallback model, not the role's primary — on success AND failure.
        // Budget note: budget stops are intentional successes, but the model
        // must know the output is partial.
        const fallbackNote = formatFallbackNote(result);
        const budgetNote = formatBudgetNote(result);

        // Aborts and spawn crashes arrive here too: the engine resolves them
        // into failed results that keep the partial frame (task, activity,
        // output, usage), so the TUI renders them like any failure instead
        // of collapsing to a bare error line.
        if (isFailedResult(result)) {
          const failedText =
            `Subagent (${params.role}) failed: ${result.errorMessage || result.stderr || "unknown error"}\n\nPartial output:\n${result.output}` +
            fallbackNote;
          emit([result], failedText);
          return {
            content: [{ type: "text", text: failedText }],
            details: { results: [result] },
          };
        }

        const finalText = result.output + budgetNote + fallbackNote + formatUsageFooter(result);
        emit([result], finalText);
        return {
          content: [{ type: "text", text: finalText }],
          details: { results: [result] },
        };
      } finally {
        // Cancel any trailing throttled onUpdate regardless of how we exited.
        // A stale "still running" progress event fired after the tool returns
        // corrupts framework tool state and crashes the TUI.
        progressThrottle.cancel();
        unsubscribe();
      }
    },

    // TUI rendering lives in ./render.ts (foreground) and ./render-async.ts
    // (background input block) — call row and result view.
    renderCall(args, theme, context) {
      return (args as any).background
        ? renderBackgroundDelegateCall(args, theme, context)
        : renderDelegateCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      // The background flag is not part of the result — route on details shape:
      // background results carry BackgroundDelegateDetails (id), foreground ones
      // carry SubagentDetails (mode/results, never an id field).
      const details = result.details as { id?: unknown } | undefined;
      return typeof details?.id === "string"
        ? renderBackgroundDelegateResult(result, options, theme, context)
        : renderDelegateResult(result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for background subagents",
    description:
      "Block until one or more background subagents (started via subagent_delegate with background: true) finish. Omit ids to wait for ALL current background runs. Returns ONLY each run's final status — one `id (role): finished/failed` line per run, never the results; fetch them afterwards with subagent_check. If timeout_ms elapses before every run finishes, returns an error listing per-run statuses. Cancelling the wait never cancels the runs — to stop a run, use subagent_cancel(id).",
    promptSnippet: "Wait for background subagents to finish",
    parameters: Type.Object({
      ids: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          description:
            "Run ids returned by background delegate calls. Omit to wait for all current background runs.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description:
            "Max time to wait in milliseconds. Omit to wait until all runs finish (each run still has its own role timeout).",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const ids = params.ids ? [...new Set(params.ids)] : [...backgroundRuns.keys()];
      if (ids.length === 0) {
        throw new Error(
          "No background runs to wait for — start one with subagent_delegate(background: true) first.",
        );
      }
      const unknown = ids.filter((id) => !backgroundRuns.has(id));
      if (unknown.length > 0) {
        const active = [...backgroundRuns.values()].map((r) => `${r.id} (${r.role})`);
        const collectedNotes = unknown
          .filter((id) => collectedRuns.has(id))
          .map((id) => `${id} was already collected (result is in your history)`);
        const trulyUnknown = unknown.filter((id) => !collectedRuns.has(id));
        const parts = [
          `Unknown subagent id(s): ${trulyUnknown.length > 0 ? trulyUnknown.join(", ") : "(none)"}.`,
          collectedNotes.length > 0 ? `${collectedNotes.join("; ")}.` : "",
          `Active: ${active.length > 0 ? active.join(", ") : "(none)"}.`,
        ].filter(Boolean);
        throw new Error(parts.join(" "));
      }
      const runs = ids.map((id) => backgroundRuns.get(id)!);
      const timeoutMs =
        typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : 0;

      // ── Live mirror: forward combined snapshots into this tool row ──
      const entries = () => runs.map((r) => ({ id: r.id, role: r.role, result: r.snapshot }));
      const emit = () => {
        const counts = { queued: 0, running: 0, finished: 0, failed: 0 };
        for (const r of runs) counts[r.state]++;
        const parts: string[] = [];
        if (counts.running) parts.push(`${counts.running} running`);
        if (counts.queued) parts.push(`${counts.queued} queued`);
        parts.push(`${counts.finished} finished`);
        parts.push(`${counts.failed} failed`);
        onUpdate?.({
          content: [{ type: "text", text: `waiting: ${parts.join(", ")}` }],
          details: { entries: entries() },
        });
      };
      const liveThrottle = createThrottler(emit);
      const unsubscribers = runs.map((r) =>
        r.subscribe(() => {
          if (onUpdate) liveThrottle.notify();
        }),
      );
      // First frame right away so the row shows entries immediately.
      if (onUpdate) emit();

      let timedOut = false;
      let cancelled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          Promise.all(runs.map((r) => r.promise)).then(() => resolve());
          if (timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              reject(new Error("timeout"));
            }, timeoutMs);
          }
          if (signal) {
            onAbort = () => {
              cancelled = true;
              reject(new Error("cancelled"));
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      } catch (err) {
        if (cancelled) {
          throw new Error(
            "wait was cancelled — the watched subagents keep running. Call wait or check again later.",
          );
        }
        if (!timedOut) throw err; // timeout is handled below via the timedOut flag
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        liveThrottle.cancel();
        for (const u of unsubscribers) u();
      }

      // Status line per run — same `id (role): state` shape check uses, so
      // the model can map ids to roles from wait output alone. Budget stops
      // report "finished" but their output is partial; cancelled runs keep
      // their partial output in the registry for check — flag both inline.
      const perId = () =>
        runs
          .map((r) =>
            r.result?.stopReason === "budget_exceeded"
              ? `${r.id} (${r.role}): ${r.state} (budget exceeded — output is partial)`
              : r.result?.stopReason === "cancelled"
                ? `${r.id} (${r.role}): cancelled (partial output kept)`
                : `${r.id} (${r.role}): ${r.state}`,
          )
          .join("\n");
      if (timedOut) {
        const unfinished = runs.filter((r) => r.state === "queued" || r.state === "running");
        const text =
          `Timed out after ${Math.round(timeoutMs / 1000)}s — ${unfinished.length} of ${runs.length} subagents not finished. ` +
          `Call wait again later, or check ids individually.\n${perId()}`;
        return {
          content: [{ type: "text", text }],
          details: { entries: entries(), timedOut: true },
        };
      }
      return {
        content: [{ type: "text", text: perId() }],
        details: { entries: entries() },
      };
    },

    renderCall: renderWaitCall,
    renderResult: renderWaitResult,
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check a background subagent",
    description:
      "Get an instant snapshot of ONE background subagent run: queued / running (with current activity) / finished (with the full output as the run result) / failed (with reason and partial output). Does not wait — use subagent_wait for that. Checking a terminal run collects it: the output is returned once and the run leaves the background registry. One id per call because results can be large.",
    promptSnippet: "Inspect a background subagent run",
    parameters: Type.Object({
      id: Type.String({ description: "Run id returned by a background delegate call" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const run = backgroundRuns.get(params.id);
      if (!run) {
        const collected = collectedRuns.get(params.id);
        if (collected) {
          throw new Error(
            `${params.id} (${collected.role}) was already collected — its result is in your conversation history. Check the remaining runs or delegate new ones.`,
          );
        }
        const active = [...backgroundRuns.values()].map((r) => `${r.id} (${r.role})`);
        throw new Error(
          `Unknown subagent id: ${params.id}. Active: ${active.length > 0 ? active.join(", ") : "(none)"}.`,
        );
      }

      // Freeze live frames so the snapshot's elapsed time stays static.
      const snap = run.result ? run.snapshot : freezeFrame(run.snapshot);

      // Read-once collection: a terminal check returns the result AND frees
      // the run — the output now lives in the conversation history, so the
      // registry keeps only a lightweight tombstone for id resolution.
      if (run.state === "finished" || run.state === "failed") {
        backgroundRuns.delete(run.id);
        collectedRuns.set(run.id, {
          id: run.id,
          role: run.role,
          task: taskPreview(run.task),
          state: run.state,
        });
      }

      return {
        content: [{ type: "text", text: formatCheckText(run.id, run.role, snap) }],
        details: { id: run.id, role: run.role, result: snap },
      };
    },

    renderCall: renderCheckCall,
    renderResult: renderCheckResult,
  });

  pi.registerTool({
    name: "subagent_steer",
    label: "Steer a running background subagent",
    description:
      "Queue a mid-run correction into ONE running background subagent — typically right after subagent_check showed it heading down a wrong path. The message is delivered after the child finishes its current tool batch, before its next LLM call; the run keeps its progress (unlike cancel). Only running runs accept steering; queued runs reject it, and terminal runs are collected by check instead. Typical flow: check → steer → check again later.",
    promptSnippet: "Send a mid-run correction to a background subagent",
    parameters: Type.Object({
      id: Type.String({ description: "Run id returned by a background delegate call" }),
      message: Type.String({
        description:
          "The correction. Concise and imperative — it lands mid-run, between the child's turns.",
      }),
    }),

    async execute(_toolCallId, params) {
      const run = backgroundRuns.get(params.id);
      if (!run) {
        const collected = collectedRuns.get(params.id);
        if (collected) {
          throw new Error(
            `${params.id} (${collected.role}) was already collected — nothing left to steer. Delegate a new run if a correction is still needed.`,
          );
        }
        const active = [...backgroundRuns.values()].map((r) => `${r.id} (${r.role})`);
        throw new Error(
          `Unknown subagent id: ${params.id}. Active: ${active.length > 0 ? active.join(", ") : "(none)"}.`,
        );
      }
      if (run.state === "queued") {
        throw new Error(
          `${params.id} (${run.role}) is still queued for a concurrency slot — steer once it is running.`,
        );
      }
      if (run.state !== "running") {
        throw new Error(
          `${params.id} (${run.role}) is ${run.state} — only running runs can be steered. subagent_check(${params.id}) returns its result.`,
        );
      }
      run.steer(params.message);
      return {
        content: [
          {
            type: "text",
            text: `Steer queued for ${params.id} (${run.role}) — delivered after its current tool batch. Verify the effect with subagent_check later.`,
          },
        ],
        details: { id: params.id, role: run.role },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel a background subagent",
    description:
      "Cancel ONE background subagent run (queued or running): the child process is killed and the run settles as cancelled (its own stop reason, same family as timeout — partial output kept), NOT as a plain failure. The reason is recorded with the run: whoever reads the partial output later via subagent_check sees why it was stopped. Cancelling does not collect — check still returns the partial output once. A finished/failed run cannot be cancelled; check it instead.",
    promptSnippet: "Cancel a background subagent run",
    parameters: Type.Object({
      id: Type.String({ description: "Run id returned by a background delegate call" }),
      reason: Type.Optional(
        Type.String({
          description:
            "Why the run is no longer needed (a few words suffice). Recorded with the run — whoever reads the partial output later (via subagent_check or history) sees why it was stopped.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const run = backgroundRuns.get(params.id);
      if (!run) {
        const collected = collectedRuns.get(params.id);
        if (collected) {
          throw new Error(
            `${params.id} (${collected.role}) was already collected — its result is in your conversation history. There is nothing left to cancel.`,
          );
        }
        const active = [...backgroundRuns.values()].map((r) => `${r.id} (${r.role})`);
        throw new Error(
          `Unknown subagent id: ${params.id}. Active: ${active.length > 0 ? active.join(", ") : "(none)"}.`,
        );
      }

      // Terminal runs cannot be cancelled — point at the collector instead.
      if (run.state === "finished" || run.state === "failed") {
        const what = run.state === "finished" ? "its result" : "the failure reason and partial output";
        const text =
          `${params.id} (${run.role}) already ${run.state} — nothing to cancel. ` +
          `subagent_check(${params.id}) returns ${what}.`;
        return {
          content: [{ type: "text", text }],
          details: { id: run.id, role: run.role, result: run.snapshot },
        };
      }

      // Abort, then wait for the terminal frame: SIGTERM → child cleanup →
      // cancelled frame carrying the partial output. Bounded by the kill
      // escalation grace (SIGKILL after 5s), so this await cannot hang.
      // The reason becomes the terminal errorMessage verbatim — check and
      // history readers see it prefixed "cancelled — ...".
      run.abort(params.reason?.trim() || "no longer needed");
      const result = await run.promise;
      return {
        content: [{ type: "text", text: formatCancelText(run.id, run.role, result) }],
        details: { id: run.id, role: run.role, result },
      };
    },

    // Confirmation-only view — the partial output renders only in a check
    // row (layer contract: cancel intervenes, check fetches).
    renderCall: renderCancelCall,
    renderResult: renderCancelResult,
  });

  pi.registerCommand("subagent:view", {
    description: "Open the live subagent activity view (watch progress, steer runs)",
    handler: async (_args, ctx) => {
      // Union of every known run: background registry (until collected) plus
      // live in-flight runs (foreground delegate calls included). Dedupe by id —
      // background runs appear in both.
      const runsProvider = () => {
        const seen = new Set<string>();
        const out: RunHandle[] = [];
        for (const r of [...backgroundRuns.values(), ...liveRuns]) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            out.push(r);
          }
        }
        return out;
      };
      if (runsProvider().length === 0) {
        ctx.ui.notify("No subagent runs yet.", "info");
        return;
      }
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) =>
          createViewPanel(runsProvider, tui, theme, () => done(undefined)),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" },
        },
      );
    },
  });

  pi.registerCommand("subagent:doctor", {
    description: "Diagnose pi-subagent configuration and dependencies",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      let allOk = true;

      // 1. pi invocation (informational — resolution is only exercised at delegate time)
      const inv = getPiInvocation(["--version"]);
      lines.push(`[i] pi invocation: ${inv.command} ${inv.args.slice(0, 2).join(" ")}`);

      // 2. pi-model-roles
      try {
        const api = getModelRolesAPI();
        lines.push("[\u2713] pi-model-roles: loaded");

        // 3. config
        try {
          const cfg = loadSubagentConfig(ctx.cwd);
          lines.push(
            `[\u2713] config: concurrency=${cfg.maxConcurrency || "∞"} depth=${cfg.maxDepth || "∞"} turns=${cfg.maxTurns || "∞"} cost=$${cfg.maxCost || "∞"} summary=${cfg.summary.enabled ? cfg.summary.role : "off"} history=${cfg.history.enabled}`,
          );
        } catch {
          lines.push("[\u2717] config: failed to load");
          allOk = false;
        }

        // 4. roles (+ fallbackRole + subagentRoles references)
        for (const [name, role] of Object.entries(availableRoles)) {
          try {
            const resolved = await api.resolveRoleAsync(role.role);
            if (resolved.model) {
              lines.push(
                `[\u2713] role ${name}: \u2192 ${resolved.model.provider}/${resolved.model.id}`,
              );
            } else {
              lines.push(`[\u2717] role ${name}: model not resolved (role config: ${role.role})`);
              allOk = false;
            }
          } catch {
            lines.push(`[\u2717] role ${name}: resolution failed`);
            allOk = false;
          }

          // fallbackRole must also resolve to a usable model
          if (role.fallbackRole) {
            try {
              const fb = await api.resolveRoleAsync(role.fallbackRole);
              if (!fb.model) {
                lines.push(
                  `[\u2717] role ${name}: fallbackRole "${role.fallbackRole}" not resolved`,
                );
                allOk = false;
              }
            } catch {
              lines.push(
                `[\u2717] role ${name}: fallbackRole "${role.fallbackRole}" resolution failed`,
              );
              allOk = false;
            }
          }

          // subagentRoles must reference known roles
          if (role.subagentRoles) {
            for (const ref of role.subagentRoles) {
              if (!(ref in availableRoles)) {
                lines.push(`[\u2717] role ${name}: subagentRoles references unknown role "${ref}"`);
                allOk = false;
              }
            }
          }
        }
      } catch {
        lines.push("[\u2717] pi-model-roles: not initialized");
        allOk = false;
      }

      // 5. runtime context
      const allowed = process.env.PI_SUBAGENT_ALLOWED;
      if (allowed) lines.push(`[i] PI_SUBAGENT_ALLOWED: ${allowed}`);
      lines.push(
        `[i] depth: ${CURRENT_DEPTH}/${config.maxDepth || "∞"}  concurrency: ${config.maxConcurrency || "∞"}`,
      );

      const summary = allOk ? "All checks passed" : "Some checks failed";
      ctx.ui.notify(`${summary}\n\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("subagent:status", {
    description: "List background subagent runs and their current state",
    handler: async (_args, ctx) => {
      if (backgroundRuns.size === 0 && collectedRuns.size === 0) {
        ctx.ui.notify("No background runs.", "info");
        return;
      }
      const lines: string[] = [];
      if (backgroundRuns.size > 0) {
        lines.push("Active:");
        for (const run of backgroundRuns.values()) {
          // Freeze live frames so elapsed-dependent details don't drift in the listing.
          const snap = run.result ? run.snapshot : freezeFrame(run.snapshot);
          let icon: string;
          let detail: string;
          if (run.state === "failed") {
            icon = "\u2717";
            detail = snap.errorMessage || "unknown error";
          } else if (run.state === "finished") {
            icon = "\u2713";
            detail = snap.summary || taskPreview(snap.output) || "(no output)";
          } else if (run.state === "queued") {
            icon = "\u23F8";
            detail = "queued — waiting for a concurrency slot";
          } else {
            icon = "\u23F3";
            detail = `running — ${describeCurrentActivity(snap)}`;
          }
          lines.push(`${icon} ${run.id} (${run.role}): ${detail}`);
        }
      }
      if (collectedRuns.size > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("Collected (result already returned via subagent_check):");
        for (const c of collectedRuns.values()) {
          lines.push(`\u2713 ${c.id} (${c.role}): ${c.state} — "${c.task}"`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("subagent:cancel", {
    description: "Cancel a background subagent run: /subagent:cancel <id|all> [reason]",
    getArgumentCompletions: (prefix) => {
      const items: Array<{ value: string; label: string; description?: string }> = [];
      for (const run of backgroundRuns.values()) {
        if (run.state === "queued" || run.state === "running") {
          items.push({ value: run.id, label: run.id, description: `${run.role} — ${run.state}` });
        }
      }
      if (items.length > 1) {
        items.push({ value: "all", label: "all", description: "cancel every live run" });
      }
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      // First token = target (id | all), the rest = free-text reason. Without
      // a reason the abort reads "cancelled by user"; with one, "cancelled by
      // user: <reason>" — the agent reading the partial output via check sees
      // that the user (not the model) stopped the run, and why.
      const trimmed = args.trim();
      const spaceIdx = trimmed.indexOf(" ");
      const target = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const reason = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (!target) {
        const live = [...backgroundRuns.values()]
          .filter((r) => r.state === "queued" || r.state === "running")
          .map((r) => `${r.id} (${r.role})`);
        ctx.ui.notify(
          `Usage: /subagent:cancel <id|all> [reason]\nLive runs: ${live.length > 0 ? live.join(", ") : "(none)"}`,
          "info",
        );
        return;
      }

      if (target !== "all" && !backgroundRuns.has(target)) {
        const collected = collectedRuns.get(target);
        const active = [...backgroundRuns.values()].map((r) => `${r.id} (${r.role})`);
        ctx.ui.notify(
          (collected
            ? `${target} (${collected.role}) was already collected — nothing to cancel.`
            : `Unknown subagent id: ${target}.`) +
            ` Active: ${active.length > 0 ? active.join(", ") : "(none)"}.`,
          "error",
        );
        return;
      }

      // "all" targets only live runs; a named id that finished meanwhile is
      // reported as already-terminal instead of cancelled.
      const targets =
        target === "all"
          ? [...backgroundRuns.values()].filter((r) => r.state === "queued" || r.state === "running")
          : [backgroundRuns.get(target)!];
      if (targets.length === 0) {
        ctx.ui.notify("No live background runs to cancel.", "info");
        return;
      }

      const abortReason = reason.trim() ? `user: ${reason.trim()}` : "user";
      const lines: string[] = [];
      for (const run of targets) {
        if (run.state === "finished" || run.state === "failed") {
          lines.push(`\u2022 ${run.id} (${run.role}) already ${run.state} — nothing to cancel`);
          continue;
        }
        run.abort(abortReason);
        const result = await run.promise;
        lines.push(
          result.usage.turns > 0 || result.output
            ? `\u2717 ${run.id} (${run.role}): cancelled after ${result.usage.turns} turn${result.usage.turns === 1 ? "" : "s"} — partial output kept (subagent_check / history)`
            : `\u2717 ${run.id} (${run.role}): cancelled (nothing had run yet)`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
