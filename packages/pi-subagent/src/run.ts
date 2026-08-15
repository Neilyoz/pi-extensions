/**
 * The delegation run engine — one async pipeline per delegate call, shared by
 * the foreground (blocking) and background tool paths. Foreground delegation
 * is background delegation that the tool call blocks on.
 *
 * startSubagentRun() returns a live RunHandle immediately: a small state
 * machine exposing the latest TUI-ready snapshot frame, a promise that always
 * resolves with the terminal result (never rejects — pipeline throws are
 * exposed via `thrown`), and a subscriber list the `wait` tool uses to mirror
 * live progress into its own tool row.
 *
 * All post-processing (fallback retry, output compression, summary
 * generation, history persistence) runs inside the pipeline, so background
 * runs finish exactly like foreground ones.
 */

import type { ModelRolesAPI, ThinkingLevel } from "@d3ara1n/pi-model-roles";
import type {
  FallbackFrom,
  RunState,
  SubagentConfig,
  SubagentResult,
  SubagentRole,
} from "./types.ts";
import { spawnSubagent } from "./spawn.ts";
import {
  MAX_OUTPUT_CHARS,
  AsyncSemaphore,
  buildFallbackFrom,
  effectiveTimeout,
  emptyUsage,
  isFailedResult,
  isProviderError,
} from "./utils.ts";
import { compressOutput, generateSummary } from "./output.ts";
import { persistSubagentHistory } from "./history.ts";

export interface RunHandle {
  /** Registry id (sub-N). */
  readonly id: string;
  readonly role: string;
  readonly task: string;
  readonly context?: string;
  readonly files?: string[];
  /** Lifecycle state, kept in sync with the latest snapshot frame. */
  readonly state: RunState;
  /** Latest frame: queued placeholder, live progress, or terminal result. */
  readonly snapshot: SubagentResult;
  /** Terminal result; undefined while queued/running. */
  readonly result: SubagentResult | undefined;
  /** Set when the pipeline threw (abort, spawn crash). Foreground callers rethrow; wait/check only see state "failed". */
  readonly thrown: Error | undefined;
  /** Resolves with the terminal result once the run finishes (always succeeds). */
  readonly promise: Promise<SubagentResult>;
  /** Get notified on every frame change. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

export interface StartRunOptions {
  id: string;
  /** delegate toolCallId — names the history record. */
  toolCallId: string;
  /** Role name key (params.role). */
  role: string;
  roleDef: SubagentRole;
  task: string;
  context?: string;
  files?: string[];
  cwd: string;
  /** Nesting depth for the child (CURRENT_DEPTH + 1). */
  depth: number;
  /** Foreground callers pass the tool's AbortSignal; background runs pass none and outlive the turn. */
  signal?: AbortSignal;
  /** Per-call model override ('provider/model-id'), bypassing the role's configured model. */
  modelOverride?: string;
  config: SubagentConfig;
  gate: AsyncSemaphore;
  /** May throw when pi-model-roles is not initialized — becomes a failed run. */
  getRolesApi: () => ModelRolesAPI;
  /** History sessionId lookup (best-effort, wrapped in try/catch). */
  getSessionId?: () => string | undefined;
  /** @internal — injectable spawn for tests. */
  spawnImpl?: typeof spawnSubagent;
}

export function startSubagentRun(opts: StartRunOptions): RunHandle {
  const spawn = opts.spawnImpl ?? spawnSubagent;
  const listeners = new Set<() => void>();

  const inputFrame = (exitCode: number, queued: boolean): SubagentResult => ({
    role: opts.role,
    task: opts.task,
    exitCode,
    queued: queued || undefined,
    messages: [],
    output: "",
    stderr: "",
    usage: emptyUsage(),
    activityLog: [],
    files: opts.files,
    context: opts.context,
  });

  let currentState: RunState = "queued";
  let snapshot: SubagentResult = inputFrame(-1, true);
  let result: SubagentResult | undefined;
  let thrown: Error | undefined;
  let resolvePromise!: (r: SubagentResult) => void;
  const promise = new Promise<SubagentResult>((resolve) => {
    resolvePromise = resolve;
  });

  const notify = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* listener errors never break the run */
      }
    }
  };
  const setFrame = (frame: SubagentResult, state: RunState) => {
    snapshot = frame;
    currentState = state;
    notify();
  };
  const finish = (terminal: SubagentResult, error?: Error) => {
    result = terminal;
    snapshot = terminal;
    thrown = error;
    currentState = isFailedResult(terminal) ? "failed" : "succeeded";
    notify();
    resolvePromise(terminal);
  };

  const handle: RunHandle = {
    id: opts.id,
    role: opts.role,
    task: opts.task,
    context: opts.context,
    files: opts.files,
    get state() {
      return currentState;
    },
    get snapshot() {
      return snapshot;
    },
    get result() {
      return result;
    },
    get thrown() {
      return thrown;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    promise,
  };

  (async () => {
    // ── Concurrency gate (abortable while queued) ──
    try {
      await opts.gate.acquire(opts.signal);
    } catch {
      const msg = `Subagent (${opts.role}) was cancelled while queued.`;
      finish({ ...inputFrame(1, false), errorMessage: msg }, new Error("cancelled while queued"));
      return;
    }

    try {
      // Resolve the model AFTER acquiring so the queued period stays zero-cost.
      let rolesApi: ModelRolesAPI;
      try {
        rolesApi = opts.getRolesApi();
      } catch {
        finish({
          ...inputFrame(1, false),
          errorMessage: "pi-model-roles is not initialized. Cannot resolve model for subagent.",
        });
        return;
      }

      let modelRef: string;
      let thinking: ThinkingLevel | undefined;
      if (opts.modelOverride) {
        modelRef = opts.modelOverride;
      } else {
        const resolved = await rolesApi.resolveRoleAsync(opts.roleDef.role);
        if (!resolved.model) {
          finish({
            ...inputFrame(1, false),
            errorMessage: `Role "${opts.roleDef.role}" could not be resolved. Model not available.`,
          });
          return;
        }
        modelRef = `${resolved.model.provider}/${resolved.model.id}`;
        thinking = resolved.config.thinking;
      }

      const startTime = Date.now();
      /** Snapshot of a failed first attempt; set before a fallback retry spawns so running frames can show the trace. */
      let activeFallbackFrom: FallbackFrom | undefined;
      // Total active-time budget for this run (ms). The clock pauses while the
      // child delegates, so this caps *active* time, not wall time.
      const timeoutBudgetMs = effectiveTimeout(opts.roleDef) * 1000;
      const maxTurns = opts.roleDef.maxTurns ?? opts.config.maxTurns;
      const maxCost = opts.roleDef.maxCost ?? opts.config.maxCost;

      // Every progress partial becomes a full TUI-ready frame.
      const liveFrame = (partial: Partial<SubagentResult>): SubagentResult => ({
        role: opts.role,
        task: opts.task,
        exitCode: -1,
        messages: partial.messages ?? [],
        output: partial.output ?? "",
        stderr: "",
        usage: partial.usage ?? emptyUsage(),
        model: partial.model,
        stopReason: partial.stopReason,
        activityLog: partial.activityLog ?? [],
        startTime,
        budgetMs: timeoutBudgetMs,
        graceMs: partial.graceMs,
        pauseStart: partial.pauseStart,
        files: opts.files,
        context: opts.context,
        fallbackFrom: activeFallbackFrom,
      });
      const emitProgress = (partial: Partial<SubagentResult>) => setFrame(liveFrame(partial), "running");

      // Running placeholder now that we hold a slot.
      setFrame(liveFrame({}), "running");

      let runResult = await spawn(modelRef, opts.task, {
        cwd: opts.cwd,
        thinking,
        tools: opts.roleDef.tools,
        systemPrompt: opts.roleDef.systemPrompt,
        context: opts.context,
        contextFiles: opts.files,
        subagentRoles: opts.roleDef.subagentRoles,
        timeoutMs: timeoutBudgetMs,
        maxTurns,
        maxCost,
        depth: opts.depth,
        signal: opts.signal,
        onProgress: emitProgress,
      });
      runResult.task = opts.task;

      // Retry with fallback role on provider errors (quota, auth, timeout, etc.)
      if (
        (runResult.exitCode !== 0 || runResult.errorMessage) &&
        opts.roleDef.fallbackRole &&
        isProviderError(runResult)
      ) {
        const fallback = await rolesApi.resolveRoleAsync(opts.roleDef.fallbackRole);
        if (fallback.model) {
          const fbRef = `${fallback.model.provider}/${fallback.model.id}`;
          // Snapshot the failed first attempt BEFORE the retry — spawn returns
          // a fresh object, but building the snapshot up front also keeps it
          // if the retry throws (abort). modelRef fills the model field when
          // the child died before any message_end; activeFallbackFrom threads
          // the trace into running frames while the retry is in flight.
          const fallbackFrom = buildFallbackFrom(runResult, modelRef);
          activeFallbackFrom = fallbackFrom;
          runResult = await spawn(fbRef, opts.task, {
            cwd: opts.cwd,
            thinking: fallback.config.thinking,
            tools: opts.roleDef.tools,
            systemPrompt: opts.roleDef.systemPrompt,
            context: opts.context,
            contextFiles: opts.files,
            subagentRoles: opts.roleDef.subagentRoles,
            timeoutMs: timeoutBudgetMs,
            maxTurns,
            maxCost,
            depth: opts.depth,
            signal: opts.signal,
            onProgress: emitProgress,
          });
          runResult.task = opts.task;
          runResult.fallbackFrom = fallbackFrom;
        }
      }

      // Stamp terminal fields once, after any fallback retry: elapsedMs covers
      // the whole delegate span (incl. retry); files/context mirror params for the TUI.
      runResult.files = opts.files;
      runResult.context = opts.context;
      runResult.elapsedMs = Date.now() - startTime;

      // Compress/truncate oversized output before it reaches the main model or TUI.
      // Keep the raw original for the history file (audit), feed the prepared text to LLM + expanded view.
      const rawOutput = runResult.output;
      if (runResult.output.length > MAX_OUTPUT_CHARS) {
        const { text, method } = await compressOutput(
          rolesApi,
          runResult.output,
          opts.task,
          opts.config.summary,
        );
        runResult.output = text;
        runResult.outputMethod = method;
      } else {
        runResult.outputMethod = "raw";
      }

      // Generate summary for TUI display
      if (opts.config.summary.enabled && runResult.output.trim()) {
        runResult.summary = await generateSummary(rolesApi, runResult.output, opts.config.summary);
      }

      // Persist audit record (best-effort; covers both success and failure).
      // History keeps the raw original output even when LLM/TUI saw a compressed/truncated version.
      if (opts.config.history.enabled) {
        let sessionId: string | undefined;
        try {
          sessionId = opts.getSessionId?.();
        } catch {
          /* ignore */
        }
        persistSubagentHistory(sessionId, opts.toolCallId, opts.role, opts.task, runResult, rawOutput);
      }

      finish(runResult);
    } catch (err: any) {
      // Keep whatever the last live frame gathered so aborted/crashed runs
      // still show their partial activity and usage.
      const partial = snapshot;
      finish(
        {
          ...inputFrame(1, false),
          messages: partial.messages,
          output: partial.output,
          usage: partial.usage,
          model: partial.model,
          stopReason: partial.stopReason,
          activityLog: partial.activityLog,
          budgetMs: partial.budgetMs,
          elapsedMs: partial.startTime ? Date.now() - partial.startTime : undefined,
          errorMessage: err?.message || String(err),
        },
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      opts.gate.release();
    }
  })();

  return handle;
}
