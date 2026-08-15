/**
 * Unit tests for pi-subagent pure helpers.
 *
 * Zero-dependency: runs on node's built-in test runner.
 *   node --test packages/pi-subagent/src/utils.test.ts
 *
 * These guard the bug fixes introduced during the improvement rounds:
 * path-injection (sanitizeFilename), concurrency/abort/negative-active/unlimited
 * semantics (AsyncSemaphore), provider-error word list (isProviderError), unknown-tool
 * formatting (previewArgs), output truncation fallback (truncateOutput).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeFilename,
  isProviderError,
  AsyncSemaphore,
  previewArgs,
  truncateOutput,
  formatTokens,
  effectiveTimeout,
  elapsedSeconds,
  hasFailedSubagentResult,
  buildFallbackFrom,
  formatFallback,
  FALLBACK_STDERR_TAIL,
  deriveRunState,
  isWaitTimedOut,
  describeCurrentActivity,
  formatUsageFooter,
  formatFallbackNote,
  formatCheckText,
  freezeFrame,
} from "./utils.ts";
import type { SubagentResult, SubagentRole } from "./types.ts";

/** Shared SubagentResult fixture. */
const baseResult = (overrides: Partial<SubagentResult> = {}): SubagentResult => ({
  role: "worker",
  task: "test task",
  exitCode: 0,
  messages: [],
  output: "ok",
  stderr: "",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  },
  activityLog: [],
  ...overrides,
});

describe("subagent failure details", () => {

  test("detects failed delegate results for tool_result error marking", () => {
    assert.equal(
      hasFailedSubagentResult({ mode: "single", results: [baseResult({ exitCode: 1 })] }),
      true,
    );
    assert.equal(
      hasFailedSubagentResult({ mode: "single", results: [baseResult({ stopReason: "timeout" })] }),
      true,
    );
  });

  test("does not mark successful or malformed details as failed", () => {
    assert.equal(hasFailedSubagentResult({ mode: "single", results: [baseResult()] }), false);
    assert.equal(hasFailedSubagentResult({ mode: "single", results: [] }), false);
    assert.equal(hasFailedSubagentResult(undefined), false);
    assert.equal(hasFailedSubagentResult({}), false);
  });
});

// ── sanitizeFilename: guards the path-injection fix ──
describe("sanitizeFilename", () => {
  test("never yields a path separator (no directory traversal)", () => {
    // Core security contract: result contains no / or \, so it can't escape the dir via path.join.
    for (const input of ["../../etc", "../passwd", "/etc/passwd", "a/b/c", "a\\b", "..", "///"]) {
      const out = sanitizeFilename(input);
      assert.ok(!out.includes("/"), `${input} -> "${out}" still contains /`);
      assert.ok(!out.includes("\\"), `${input} -> "${out}" still contains \\`);
    }
  });
  test("empty string falls back to unknown", () => {
    assert.equal(sanitizeFilename(""), "unknown");
  });
  test("pure-dots collapses to unknown (leading dots stripped, rest empty)", () => {
    assert.equal(sanitizeFilename(".."), "unknown");
    assert.equal(sanitizeFilename("..."), "unknown");
  });
  test("special chars become underscores", () => {
    assert.equal(sanitizeFilename("!!!"), "___");
    assert.equal(sanitizeFilename("   "), "___");
    assert.equal(sanitizeFilename("///"), "___");
    assert.equal(sanitizeFilename("a/b/c"), "a_b_c");
  });
  test("keeps normal uuid/alnum/dots/dashes as-is", () => {
    const id = "019eff4f-b603-7623-9eaa-17d32eb623d9";
    assert.equal(sanitizeFilename(id), id);
    assert.equal(sanitizeFilename("call_abc123.json"), "call_abc123.json");
  });
});

// ── isProviderError: guards the #9 expanded word list ──
describe("isProviderError", () => {
  const mk = (stderr: string, errorMessage = ""): SubagentResult => baseResult({ stderr, errorMessage });

  test("matches provider error keywords", () => {
    const cases = [
      "429 Too Many Requests",
      "quota exceeded",
      "rate limit exceeded",
      "authentication error",
      "request timeout",
      "quota exhausted",
      "service unavailable",
      "503 Service Unavailable",
      "internal server error",
      "temporary failure",
      "request declined",
      "server overloaded",
      "ECONNRESET",
      "socket hang up",
      "EPIPE",
      "network error",
      "connection refused",
    ];
    for (const c of cases) {
      assert.equal(isProviderError(mk(c)), true, `should match: ${c}`);
    }
  });
  test("does not match business/programming errors", () => {
    assert.equal(isProviderError(mk("TypeError: Cannot read properties of undefined")), false);
    assert.equal(isProviderError(mk("Error: test failed, expected 5 got 3")), false);
    assert.equal(isProviderError(mk("AssertionError: values differ")), false);
    assert.equal(isProviderError(mk("")), false);
  });
  test("checks errorMessage too, not just stderr", () => {
    assert.equal(isProviderError(mk("", "rate limited")), true);
  });
});

// ── AsyncSemaphore: guards concurrency cap, negative-active, abort cleanup ──
describe("AsyncSemaphore", () => {
  test("never goes negative on extra release", async () => {
    const s = new AsyncSemaphore(1);
    await s.acquire();
    s.release();
    s.release();
    s.release();
    assert.equal((s as any).active, 0);
  });
  test("respects concurrency cap (queues beyond max)", async () => {
    const s = new AsyncSemaphore(2);
    await s.acquire();
    await s.acquire();
    let entered = false;
    const p = s.acquire().then(() => {
      entered = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(entered, false); // still queued
    s.release();
    await p;
    assert.equal(entered, true);
  });
  test("abort removes waiter from queue and rejects", async () => {
    const s = new AsyncSemaphore(1);
    await s.acquire();
    const c = new AbortController();
    const p = s.acquire(c.signal);
    c.abort();
    await assert.rejects(p);
    assert.equal((s as any).waiters.length, 0);
  });
  test("unlimited max (0) never queues or reports capacity", async () => {
    const s = new AsyncSemaphore(0);
    assert.equal(s.isLimited, false);
    assert.equal(s.isAtCapacity, false);

    let acquired = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        s.acquire().then(() => {
          acquired++;
        }),
      ),
    );

    assert.equal(acquired, 10);
    assert.equal((s as any).waiters.length, 0);
    assert.equal(s.isAtCapacity, false);
  });
  test("positive max reports capacity and retains FIFO queueing", async () => {
    const s = new AsyncSemaphore(1);
    await s.acquire();
    assert.equal(s.isAtCapacity, true);

    const order: number[] = [];
    const p1 = s.acquire().then(() => order.push(1));
    const p2 = s.acquire().then(() => order.push(2));
    assert.equal((s as any).waiters.length, 2);

    s.release();
    await p1;
    s.release();
    await p2;
    assert.deepEqual(order, [1, 2]);
  });
  test("releases queued waiters in FIFO order", async () => {
    const s = new AsyncSemaphore(1);
    await s.acquire();
    const order: number[] = [];
    const p1 = s.acquire().then(() => order.push(1));
    const p2 = s.acquire().then(() => order.push(2));
    const p3 = s.acquire().then(() => order.push(3));
    s.release();
    await p1;
    s.release();
    await p2;
    s.release();
    await p3;
    assert.deepEqual(order, [1, 2, 3]);
  });
  test("acquires immediately when under cap", async () => {
    const s = new AsyncSemaphore(3);
    await s.acquire();
    await s.acquire();
    assert.equal((s as any).active, 2);
  });
});

// ── previewArgs: guards the #10 shape-based formatting ──
describe("previewArgs", () => {
  test("command -> $ prefix", () => {
    assert.equal(previewArgs({ command: "ls -la" }), "$ ls -la");
  });
  test("command truncated at 60 chars", () => {
    const long = "x".repeat(70);
    const r = previewArgs({ command: long });
    assert.ok(r.startsWith("$ "));
    assert.ok(r.endsWith("..."));
    assert.ok(r.length < long.length);
  });
  test("file_path is shortened (home -> ~)", () => {
    const r = previewArgs({ file_path: "/home/user/foo.ts" });
    assert.ok(r.includes("foo.ts"));
  });
  test("url passthrough (truncated when long)", () => {
    assert.equal(previewArgs({ url: "https://example.com" }), "https://example.com");
    const longUrl = "https://" + "x".repeat(70);
    assert.ok(previewArgs({ url: longUrl }).endsWith("..."));
  });
  test("query/pattern/regex/search -> /.../  form", () => {
    assert.equal(previewArgs({ query: "foo" }), "/foo/");
    assert.equal(previewArgs({ pattern: "bar" }), "/bar/");
    assert.equal(previewArgs({ regex: "baz" }), "/baz/");
    assert.equal(previewArgs({ search: "qux" }), "/qux/");
  });
  test("empty object falls back to JSON {}", () => {
    assert.equal(previewArgs({}), "{}");
  });
});

// ── effectiveTimeout: per-role timeout resolution (seconds) ──
describe("effectiveTimeout", () => {
  const role = (tools: string[], timeout?: number): SubagentRole =>
    ({
      role: "default",
      description: "",
      examples: [],
      decisionTrigger: "",
      tools,
      systemPrompt: "",
      timeout,
    }) as unknown as SubagentRole;

  test("role without timeout is unlimited", () => {
    assert.equal(effectiveTimeout(role(["read", "grep"])), 0);
  });
  test("delegate-capable role without timeout is also unlimited", () => {
    assert.equal(effectiveTimeout(role(["read", "subagent_delegate"])), 0);
  });
  test("explicit role timeout is honored", () => {
    assert.equal(effectiveTimeout(role(["read", "subagent_delegate"], 300)), 300);
  });
  test("negative and non-finite values normalize to unlimited", () => {
    assert.equal(effectiveTimeout(role(["read"], -1)), 0);
    assert.equal(effectiveTimeout(role(["read"], Number.POSITIVE_INFINITY)), 0);
  });
});

// ── truncateOutput: guards the #2 head+tail fallback ──
describe("truncateOutput", () => {
  test("adds truncation header with original length", () => {
    const big = "x".repeat(60000);
    const r = truncateOutput(big);
    assert.ok(r.startsWith("[Output truncated"));
    assert.ok(r.includes("60000 chars total"));
    assert.ok(r.includes("[truncated]"));
  });
  test("keeps head and tail, drops the middle", () => {
    // 120000 chars: 40k H + 40k M + 40k T
    const content = "H".repeat(40000) + "M".repeat(40000) + "T".repeat(40000);
    const r = truncateOutput(content);
    assert.ok(r.includes("H"), "head preserved");
    assert.ok(r.includes("T"), "tail preserved");
    assert.ok(!r.includes("M"), "middle dropped");
  });
});

// ── formatTokens: boundary correctness ──
describe("formatTokens", () => {
  test("under 1000 stays raw", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
  });
  test("1000-9999 with one decimal place", () => {
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(9500), "9.5k");
    // 9999/1000 = 9.999, toFixed(1) rounds up to 10.0
    assert.equal(formatTokens(9999), "10.0k");
  });
  test("10000-999999 rounded to integer k", () => {
    assert.equal(formatTokens(10000), "10k");
    assert.equal(formatTokens(999999), "1000k");
  });
  test(">= 1000000 in M", () => {
    assert.equal(formatTokens(1000000), "1.0M");
  });
});

// ── elapsedSeconds: live/terminal time derivation ──
describe("elapsedSeconds", () => {
  test("terminal state: rounds elapsedMs to whole seconds", () => {
    assert.equal(elapsedSeconds({ exitCode: 0, elapsedMs: 12345 }), 12);
    assert.equal(elapsedSeconds({ exitCode: 0, elapsedMs: 400 }), 0);
    assert.equal(elapsedSeconds({ exitCode: 1, elapsedMs: 59999 }), 60);
  });
  test("terminal state without elapsedMs -> undefined", () => {
    assert.equal(elapsedSeconds({ exitCode: 0 }), undefined);
  });
  test("queued (running sentinel, no startTime) -> undefined", () => {
    assert.equal(elapsedSeconds({ exitCode: -1 }), undefined);
  });
  test("running: live seconds from startTime (within ~1s drift)", () => {
    const start = Date.now() - 3500;
    const s = elapsedSeconds({ exitCode: -1, startTime: start });
    assert.ok(s !== undefined, "should be defined while running");
    assert.ok(s >= 3 && s <= 4, `expected ~3s, got ${s}`);
  });
  test("running: clamps negative drift (future startTime) to 0", () => {
    const start = Date.now() + 10000; // 10s in the future
    assert.equal(elapsedSeconds({ exitCode: -1, startTime: start }), 0);
  });
});

describe("fallback observability", () => {
  const failed = (overrides: Partial<SubagentResult> = {}): SubagentResult =>
    baseResult({
      role: "researcher",
      exitCode: 1,
      model: "opencode-go/deepseek-v4-flash",
      stopReason: "timeout",
      errorMessage: "Timed out after 900s",
      ...overrides,
    });

  test("buildFallbackFrom snapshots the failed attempt", () => {
    const f = buildFallbackFrom(failed());
    assert.equal(f.model, "opencode-go/deepseek-v4-flash");
    assert.equal(f.stopReason, "timeout");
    assert.equal(f.errorMessage, "Timed out after 900s");
    assert.equal(f.stderrTail, undefined);
  });

  test("buildFallbackFrom keeps a truncated stderr tail", () => {
    const noise = "x".repeat(2000);
    const f = buildFallbackFrom(failed({ stderr: `${noise}HTTP 429 at tail` }));
    assert.ok(f.stderrTail!.endsWith("HTTP 429 at tail"));
    assert.ok(f.stderrTail!.length <= FALLBACK_STDERR_TAIL);
  });

  test("buildFallbackFrom drops whitespace-only stderr", () => {
    const f = buildFallbackFrom(failed({ stderr: "   \n\t " }));
    assert.equal(f.stderrTail, undefined);
  });

  test("formatFallback prefers errorMessage", () => {
    assert.equal(
      formatFallback({ model: "ds", stopReason: "timeout", errorMessage: "boom" }),
      "first attempt ds failed (boom)",
    );
  });

  test("formatFallback falls back to stopReason then a generic label", () => {
    assert.equal(formatFallback({ model: "ds", stopReason: "timeout" }), "first attempt ds failed (timeout)");
    assert.equal(formatFallback({}), "first attempt unknown model failed (provider error)");
  });

  test("formatFallback keeps a single truncated line", () => {
    assert.equal(formatFallback({ model: "ds", errorMessage: "line1\nline2" }), "first attempt ds failed (line1)");
    const long = "y".repeat(150);
    const out = formatFallback({ model: "ds", errorMessage: long });
    assert.equal(out, `first attempt ds failed (${"y".repeat(100)}...)`);
    assert.ok(out.endsWith("...)"));
  });

  test("buildFallbackFrom fills model from the requested model when the child died early", () => {
    const f = buildFallbackFrom(failed({ model: undefined }), "opencode-go/deepseek-v4-flash");
    assert.equal(f.model, "opencode-go/deepseek-v4-flash");
  });

  test("buildFallbackFrom derives a reason from stderr when errorMessage is unset", () => {
    const f = buildFallbackFrom(
      failed({ errorMessage: undefined, stderr: "\x1b[2Knoise\nError: 429 Too Many Requests\n\x1b[?25h" }),
    );
    assert.equal(f.errorMessage, "Error: 429 Too Many Requests");
  });

  test("an explicit errorMessage wins over stderr", () => {
    const f = buildFallbackFrom(failed({ stderr: "connection reset by peer 429" }));
    assert.equal(f.errorMessage, "Timed out after 900s");
  });

  test("formatFallback shows the error message, never raw stderr content", () => {
    const f = buildFallbackFrom(failed({ stderr: "CONNECTIVITY monster line mentioning 429" }));
    const out = formatFallback(f);
    assert.ok(out.includes("Timed out after 900s"));
    assert.ok(!out.includes("CONNECTIVITY"));
  });
});

describe("background run helpers", () => {
  const queuedFrame = () => baseResult({ exitCode: -1, queued: true });
  const runningFrame = () => baseResult({ exitCode: -1 });

  test("deriveRunState maps frames to lifecycle states", () => {
    assert.equal(deriveRunState(queuedFrame()), "queued");
    assert.equal(deriveRunState(runningFrame()), "running");
    assert.equal(deriveRunState(baseResult()), "succeeded");
    assert.equal(deriveRunState(baseResult({ exitCode: 1 })), "failed");
    assert.equal(deriveRunState(baseResult({ stopReason: "timeout", exitCode: 124 })), "failed");
    // budget stops are intentional successes
    assert.equal(deriveRunState(baseResult({ stopReason: "budget_exceeded" })), "succeeded");
  });

  test("isWaitTimedOut only matches the explicit timeout flag", () => {
    assert.equal(isWaitTimedOut({ entries: [], timedOut: true }), true);
    assert.equal(isWaitTimedOut({ entries: [] }), false);
    assert.equal(isWaitTimedOut(undefined), false);
  });

  test("describeCurrentActivity reports the latest activity item", () => {
    assert.equal(describeCurrentActivity(runningFrame()), "waiting for first event");
    const thinking = runningFrame();
    thinking.activityLog = [{ kind: "thinking", id: "thinking-0", status: "running" }];
    assert.equal(describeCurrentActivity(thinking), "thinking");
    const withTool = runningFrame();
    withTool.activityLog = [
      { kind: "thinking", id: "thinking-0", status: "done" },
      { kind: "toolCall", id: "t1", status: "running", toolName: "bash", args: { command: "ls" } },
    ];
    assert.equal(describeCurrentActivity(withTool), "$ ls");
  });

  test("formatUsageFooter renders turns, tokens, cost, and model", () => {
    assert.equal(formatUsageFooter(baseResult()), "");
    const r = baseResult({
      usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 2 },
      model: "test/model-x",
    });
    assert.equal(formatUsageFooter(r), "\n\n--- 2 turns \u21911.2k \u2193300 $0.5000 test/model-x ---");
  });

  test("formatFallbackNote is empty without a retry and descriptive with one", () => {
    assert.equal(formatFallbackNote(baseResult()), "");
    const r = baseResult({
      fallbackFrom: { model: "primary/m1", errorMessage: "429 quota exceeded" },
      model: "fallback/m2",
    });
    assert.equal(
      formatFallbackNote(r),
      "\n\n--- fallback: first attempt primary/m1 failed (429 quota exceeded); retried on fallback/m2 ---",
    );
  });

  test("formatCheckText covers all four run states", () => {
    assert.match(formatCheckText("sub-1", "explorer", queuedFrame()), /^sub-1 \(explorer\): queued —/);
    assert.match(formatCheckText("sub-1", "explorer", runningFrame()), /^sub-1 \(explorer\): running — /);
    assert.match(
      formatCheckText("sub-1", "explorer", baseResult({ exitCode: 1, errorMessage: "boom" })),
      /^sub-1 \(explorer\): failed — boom\n\nPartial output:\nok$/,
    );
    assert.match(formatCheckText("sub-1", "explorer", baseResult()), /^sub-1 \(explorer\): finished\n\nok$/);
  });

  test("freezeFrame stops the elapsed clock and folds the open pause into grace", () => {
    const start = Date.now() - 5000;
    const pausedAt = Date.now() - 2000;
    const frozen = freezeFrame(baseResult({
      exitCode: -1,
      startTime: start,
      budgetMs: 60000,
      graceMs: 1000,
      pauseStart: pausedAt,
    }));
    assert.equal(frozen.startTime, undefined);
    assert.equal(frozen.pauseStart, undefined);
    assert.ok(frozen.elapsedMs! >= 4990 && frozen.elapsedMs! <= 5010, `elapsedMs ~5000, got ${frozen.elapsedMs}`);
    assert.ok(frozen.graceMs! >= 3000 && frozen.graceMs! <= 3010, `graceMs ~3000, got ${frozen.graceMs}`);
  });
});
