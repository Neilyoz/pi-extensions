/**
 * Tests for the delegation run engine — state machine transitions, snapshot
 * frames, fallback retry, and error paths, using an injected fake spawn.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { SubagentConfig, SubagentRole, SubagentResult } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { AsyncSemaphore, emptyUsage } from "./utils.ts";
import { startSubagentRun, type StartRunOptions } from "./run.ts";

const testConfig: SubagentConfig = {
  ...DEFAULT_CONFIG,
  history: { enabled: false },
  summary: { role: "utility", enabled: false },
};

const roleDef: SubagentRole = {
  role: "fast",
  description: "",
  examples: [],
  decisionTrigger: "",
  tools: ["read"],
  systemPrompt: "",
};

const fakeRolesApi = {
  resolveRoleAsync: async (role: string) => ({
    model: { provider: "test", id: `model-${role}` },
    config: {},
  }),
} as unknown as ModelRolesAPI;

function makeResult(overrides: Partial<SubagentResult>): SubagentResult {
  return {
    role: "explorer",
    task: "test task",
    exitCode: 0,
    output: "",
    stderr: "",
    usage: emptyUsage(),
    activityLog: [],
    ...overrides,
  };
}

type SpawnImpl = NonNullable<StartRunOptions["spawnImpl"]>;

function makeDeps(overrides: Partial<StartRunOptions> = {}): StartRunOptions {
  return {
    id: "sub-1",
    toolCallId: "call-1",
    role: "explorer",
    roleDef,
    task: "test task",
    cwd: "/tmp",
    depth: 1,
    config: testConfig,
    gate: new AsyncSemaphore(4),
    getRolesApi: () => fakeRolesApi,
    ...overrides,
  };
}

test("run starts queued, transitions to running, then succeeds", async () => {
  const states: string[] = [];
  const spawnImpl: SpawnImpl = async (_model, _task, options) => {
    options.onProgress?.({
      activityLog: [{ kind: "toolCall", id: "t1", status: "running", toolName: "bash", args: {} }],
      usage: { ...emptyUsage(), turns: 1 },
    });
    return makeResult({ output: "done", usage: { ...emptyUsage(), turns: 1 } });
  };

  const run = startSubagentRun(makeDeps({ spawnImpl }));
  assert.strictEqual(run.state, "queued");
  assert.ok(run.snapshot.queued, "initial snapshot is a queued frame");

  const unsubscribe = run.subscribe(() => states.push(run.state));
  const result = await run.promise;
  unsubscribe();

  assert.strictEqual(run.state, "finished");
  assert.strictEqual(run.result, result);
  assert.strictEqual(result.output, "done");
  // Terminal frames carry the registry role name (spawn itself never learns it).
  assert.strictEqual(result.role, "explorer");
  assert.ok(states.includes("running"), `saw running in ${JSON.stringify(states)}`);
  assert.strictEqual(run.thrown, undefined);
  // Terminal frame carries elapsed time and stops looking live.
  assert.strictEqual(result.exitCode, 0);
  assert.ok(typeof result.elapsedMs === "number");
  assert.strictEqual(run.snapshot.startTime, undefined);
});

test("run stays queued while the concurrency gate is full", async () => {
  const gate = new AsyncSemaphore(1);
  await gate.acquire(); // exhaust the single slot
  const spawnImpl: SpawnImpl = async () => makeResult({ output: "late" });

  const run = startSubagentRun(makeDeps({ gate, spawnImpl }));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(run.state, "queued");

  gate.release();
  const result = await run.promise;
  assert.strictEqual(run.state, "finished");
  assert.strictEqual(result.output, "late");
});

test("non-zero exit yields state failed without thrown", async () => {
  const spawnImpl: SpawnImpl = async () =>
    makeResult({ exitCode: 1, errorMessage: "boom", output: "partial" });

  const run = startSubagentRun(makeDeps({ spawnImpl }));
  const result = await run.promise;

  assert.strictEqual(run.state, "failed");
  assert.strictEqual(run.thrown, undefined);
  assert.strictEqual(result.errorMessage, "boom");
});

test("a throwing spawn resolves the promise with a failed result carrying the error", async () => {
  const spawnImpl: SpawnImpl = async (_m, _t, options) => {
    options.onProgress?.({
      output: "partial",
      activityLog: [{ kind: "toolCall", id: "t1", status: "done", toolName: "read", args: {} }],
    });
    throw new Error("Subagent was aborted");
  };

  const run = startSubagentRun(makeDeps({ spawnImpl }));
  const result = await run.promise; // never rejects

  assert.strictEqual(run.state, "failed");
  assert.ok(run.thrown instanceof Error);
  assert.strictEqual(run.thrown.message, "Subagent was aborted");
  // Non-abort crashes (spawn failure) keep the plain thrown message — the
  // cancelled stop reason is reserved for real aborts.
  assert.strictEqual(result.stopReason, undefined);
  assert.strictEqual(result.errorMessage, "Subagent was aborted");
  // The partial frame survives — the foreground path renders aborts like any
  // failure (task line + activity + result line) instead of a bare error.
  assert.strictEqual(result.output, "partial");
  assert.strictEqual(result.activityLog.length, 1);
});

test("spawned runs persist to history on every terminal path; pre-run failures do not", async () => {
  const persisted: SubagentResult[] = [];
  const persistImpl = (
    _sessionId: string | undefined,
    _toolCallId: string,
    _role: string,
    _task: string,
    r: SubagentResult,
  ) => {
    persisted.push(r);
  };
  const historyConfig = { ...testConfig, history: { enabled: true } };

  // Abort mid-run: the run spawned, so it must be audited.
  const aborted = startSubagentRun(
    makeDeps({
      config: historyConfig,
      spawnImpl: async (_m, _t, options) => {
        options.onProgress?.({
          output: "partial",
          activityLog: [
            { kind: "toolCall", id: "t1", status: "running", toolName: "bash", args: {} },
          ],
        });
        throw new Error("Subagent was aborted");
      },
      persistImpl,
    }),
  );
  await aborted.promise;
  assert.equal(persisted.length, 1);
  assert.match(persisted[0].errorMessage!, /aborted/);
  assert.equal(persisted[0].activityLog.length, 1);

  // Pre-run failure (roles api unavailable): never spawned, not audited.
  const prerun = startSubagentRun(
    makeDeps({
      config: historyConfig,
      getRolesApi: () => {
        throw new Error("not initialized");
      },
      persistImpl,
    }),
  );
  await prerun.promise;
  assert.equal(persisted.length, 1);

  // Normal success is audited too.
  const ok = startSubagentRun(
    makeDeps({
      config: historyConfig,
      spawnImpl: async () => makeResult({ output: "done" }),
      persistImpl,
    }),
  );
  await ok.promise;
  assert.equal(persisted.length, 2);
});

test("provider error on first attempt retries on the fallback role", async () => {
  const calls: string[] = [];
  const spawnImpl: SpawnImpl = async (model) => {
    calls.push(model);
    if (calls.length === 1) {
      return makeResult({ exitCode: 1, errorMessage: "429 quota exceeded", stderr: "HTTP 429" });
    }
    return makeResult({ output: "fallback ok" });
  };

  const run = startSubagentRun(
    makeDeps({
      roleDef: { ...roleDef, fallbackRole: "default" },
      spawnImpl,
    }),
  );
  const result = await run.promise;

  assert.deepStrictEqual(calls, ["test/model-fast", "test/model-default"]);
  assert.strictEqual(run.state, "finished");
  assert.strictEqual(result.output, "fallback ok");
  assert.ok(result.fallbackFrom, "terminal result records the failed first attempt");
  assert.strictEqual(result.fallbackFrom.model, "test/model-fast");
});

test("forwards an immutable inherited conversation to first and fallback spawns", async () => {
  const received: Array<{
    model: string;
    inheritConversation?: boolean;
    inheritedConversation?: string;
  }> = [];
  const spawnImpl: SpawnImpl = async (model, _task, options) => {
    received.push({
      model,
      inheritConversation: options.inheritConversation,
      inheritedConversation: options.inheritedConversation,
    });
    return received.length === 1
      ? makeResult({ exitCode: 1, errorMessage: "429 quota exceeded", stderr: "HTTP 429" })
      : makeResult({ output: "fallback ok" });
  };

  const run = startSubagentRun(
    makeDeps({
      roleDef: { ...roleDef, fallbackRole: "default" },
      inheritConversation: true,
      inheritedConversation: "[user]\\nParent requirement",
      inheritedConversationTruncated: true,
      spawnImpl,
    }),
  );
  const result = await run.promise;

  assert.deepEqual(received, [
    {
      model: "test/model-fast",
      inheritConversation: true,
      inheritedConversation: "[user]\\nParent requirement",
    },
    {
      model: "test/model-default",
      inheritConversation: true,
      inheritedConversation: "[user]\\nParent requirement",
    },
  ]);
  assert.equal(run.inheritConversation, true);
  assert.equal(run.inheritedConversationChars, "[user]\\nParent requirement".length);
  assert.equal(run.inheritedConversationTruncated, true);
  assert.equal(result.inheritConversation, true);
  assert.equal(result.inheritedConversationChars, "[user]\\nParent requirement".length);
  assert.equal(result.inheritedConversationTruncated, true);
});

test("prerun failure (roles api unavailable) becomes a failed run, not a throw", async () => {
  const run = startSubagentRun(
    makeDeps({
      getRolesApi: () => {
        throw new Error("not initialized");
      },
    }),
  );
  const result = await run.promise;

  assert.strictEqual(run.state, "failed");
  assert.strictEqual(run.thrown, undefined);
  assert.match(result.errorMessage!, /pi-model-roles is not initialized/);
});

test("abort while queued fails the run and exposes thrown for the foreground path", async () => {
  const gate = new AsyncSemaphore(1);
  await gate.acquire();
  const controller = new AbortController();
  controller.abort();

  const run = startSubagentRun(makeDeps({ gate, signal: controller.signal }));
  const result = await run.promise;

  assert.strictEqual(run.state, "failed");
  assert.ok(run.thrown instanceof Error);
  assert.strictEqual(result.stopReason, "cancelled");
  assert.match(result.errorMessage!, /still queued for a concurrency slot/);
  gate.release();
});

test("handle.abort() reaps a queued background run (no caller signal)", async () => {
  const gate = new AsyncSemaphore(1);
  await gate.acquire();
  const spawnImpl: SpawnImpl = async () => makeResult({ output: "never" });

  const run = startSubagentRun(makeDeps({ gate, spawnImpl }));
  run.abort("session shutdown");
  const result = await run.promise;

  assert.strictEqual(run.state, "failed");
  assert.ok(run.thrown instanceof Error);
  assert.strictEqual(result.stopReason, "cancelled");
  assert.strictEqual(result.errorMessage, "still queued for a concurrency slot (session shutdown)");
  gate.release();
});

test("handle.abort(reason) fails a running run with the reason in the error message", async () => {
  const signals: AbortSignal[] = [];
  // Mirrors real spawn's abort handling: pre-aborted signals settle immediately
  // (an "abort" listener alone would never fire — the event already happened).
  const honoringSpawn: SpawnImpl = (_m, _t, options) =>
    new Promise((_resolve, reject) => {
      signals.push(options.signal!);
      const die = () => reject(new Error("Subagent was aborted"));
      if (options.signal?.aborted) die();
      else options.signal?.addEventListener("abort", die, { once: true });
    });

  const run = startSubagentRun(makeDeps({ spawnImpl: honoringSpawn }));
  run.abort("session shutdown");
  const result = await run.promise;

  assert.strictEqual(run.state, "failed");
  assert.strictEqual(result.stopReason, "cancelled");
  // The abort reason becomes the errorMessage verbatim — renderers add the
  // "cancelled" framing, so the message itself must not repeat it.
  assert.strictEqual(result.errorMessage, "session shutdown");
  assert.ok(run.thrown instanceof Error);
  // The internal controller the spawn honored is the same channel abort() used.
  assert.ok(signals[0].aborted);
});

test("a pre-aborted caller signal chains into the run before spawn", async () => {
  const controller = new AbortController();
  controller.abort();
  const spawnImpl: SpawnImpl = async (_m, _t, options) => {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    return makeResult({ output: "done" });
  };

  const run = startSubagentRun(makeDeps({ signal: controller.signal, spawnImpl }));
  const result = await run.promise;

  assert.strictEqual(run.state, "failed");
  // Caller-signal abort (foreground Esc): no explicit reason was given, so
  // the cancelled frame falls back to the bare "cancelled" message.
  assert.strictEqual(result.stopReason, "cancelled");
  assert.strictEqual(result.errorMessage, "cancelled");
  // abort() after settle is a no-op — the terminal state never flips.
  run.abort("session shutdown");
  assert.strictEqual(run.state, "failed");
});

test("subscribers are notified on progress and terminal frames", async () => {
  let notifications = 0;
  const spawnImpl: SpawnImpl = async (_m, _t, options) => {
    options.onProgress?.({ output: "step 1" });
    options.onProgress?.({ output: "step 2" });
    return makeResult({ output: "final" });
  };

  const run = startSubagentRun(makeDeps({ spawnImpl }));
  const unsubscribe = run.subscribe(() => notifications++);
  await run.promise;
  unsubscribe();
  const after = notifications;
  // No further notifications after terminal (and after unsubscribing).
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(notifications, after);
  assert.ok(notifications >= 3, `progress x2 + terminal, got ${notifications}`);
});
