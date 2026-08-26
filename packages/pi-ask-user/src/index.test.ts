/**
 * Regression tests for ask_user result serialization and display sanitization.
 * Run: node --test packages/pi-ask-user/src/index.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import askUserExtension from "./index.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

async function executeAskUser(
  questions: Array<Record<string, unknown>>,
  drive: (panel: { handleInput(data: string): void; render(width: number): string[] }) => void,
) {
  let tool: any;
  askUserExtension({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as any);

  const result = await tool.execute(
    "test-call",
    { questions },
    new AbortController().signal,
    () => {},
    {
      mode: "tui",
      hasUI: true,
      ui: {
        custom(factory: any) {
          return new Promise((resolve) => {
            const panel = factory(
              { requestRender() {} },
              plainTheme,
              {},
              (value: unknown) => resolve(value),
            );
            drive(panel);
          });
        },
      },
    },
  );
  return JSON.parse(result.content[0].text);
}

test("ask_user preserves duplicate-tab answer order and adds deterministic suffixes", async () => {
  const payload = await executeAskUser(
    [
      { tab: "choice", header: "First", options: [{ label: "one" }] },
      { tab: "choice", header: "Second", options: [{ label: "two" }] },
    ],
    (panel) => {
      panel.handleInput("\r"); // First question → Second question
      panel.handleInput("\r"); // Second question → review
      panel.handleInput("\r"); // Submit review
    },
  );

  assert.deepEqual(payload, {
    cancelled: false,
    answers: [
      { tab: "choice", answer: "one" },
      { tab: "choice-2", answer: "two" },
    ],
  });
});

test("ask_user sanitizes control characters in tab labels used by the panel", async () => {
  let rendered = "";
  const payload = await executeAskUser(
    [{ tab: "\r\n\t", header: "Question", options: [{ label: "one" }] }],
    (panel) => {
      rendered = panel.render(80).join("\n");
      panel.handleInput("\u001b");
    },
  );

  assert.match(rendered, /\(unnamed\)/);
  assert.doesNotMatch(rendered, /[\r\t]/);
  assert.deepEqual(payload, { cancelled: true, answers: [] });
});

test("ask_user honors a custom toggle key from settings", async () => {
  // Redirect the global settings location into a temp dir so the test
  // controls `askUser.toggleKey` without touching the real config.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-toggle-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  try {
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({ askUser: { toggleKey: "alt+\\" } }),
    );
    await executeAskUser(
      [{ tab: "q", header: "Q", options: [{ label: "one" }] }],
      (panel) => {
        // Expanded: option list is visible.
        const expanded = panel.render(80).join("\n");
        assert.match(expanded, /one/);
        // The default toggle key (ctrl+\ = 0x1c) no longer collapses.
        panel.handleInput("\x1c");
        assert.match(panel.render(80).join("\n"), /one/);
        // The configured toggle key (alt+\ = ESC + backslash) collapses.
        panel.handleInput("\x1b\\");
        const collapsed = panel.render(80).join("\n");
        assert.doesNotMatch(collapsed, /one/);
        assert.match(collapsed, /expand/);
        // Esc still cancels from the collapsed row.
        panel.handleInput("\u001b");
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});

// ── Non-TUI (RPC/ACP) dialog degradation ──────────────────────────────────

interface DialogCalls {
  selects: Array<{ title: string; options: string[] }>;
  inputs: string[];
  confirms: Array<{ title: string; message: string }>;
}

/**
 * Drive the tool in rpc mode with a scripted dialog host. `answers` is a queue:
 * each select() call shifts one value (undefined = cancelled); each input()
 * call shifts one value; each confirm() call shifts one boolean.
 */
async function executeRpc(
  questions: Array<Record<string, unknown>>,
  script: { select?: (string | undefined)[]; input?: (string | undefined)[]; confirm?: boolean[] },
): Promise<{ payload: any; calls: DialogCalls }> {
  let tool: any;
  askUserExtension({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as any);

  const calls: DialogCalls = { selects: [], inputs: [], confirms: [] };
  const selectQueue = [...(script.select ?? [])];
  const inputQueue = [...(script.input ?? [])];
  const confirmQueue = [...(script.confirm ?? [])];

  const result = await tool.execute(
    "test-call",
    { questions },
    new AbortController().signal,
    () => {},
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async (_title: string, options: string[]) => {
          calls.selects.push({ title: _title, options });
          return selectQueue.shift();
        },
        input: async (title: string, _placeholder?: string) => {
          calls.inputs.push(title);
          return inputQueue.shift();
        },
        confirm: async (title: string, message: string) => {
          calls.confirms.push({ title, message });
          return confirmQueue.shift();
        },
      },
    },
  );
  return { payload: JSON.parse(result.content[0].text), calls };
}

test("rpc: single-select answered via select() keeps the payload contract", async () => {
  const { payload, calls } = await executeRpc(
    [{ tab: "pick", header: "Which?", prompt: "choose one", options: [
      { label: "one", description: "first option" },
      { label: "two" },
    ] }],
    { select: ["two"] },
  );

  // Description folds into the option display but the answer echoes the label.
  assert.deepEqual(payload, { cancelled: false, answers: [{ tab: "pick", answer: "two" }] });
  assert.equal(calls.selects.length, 1);
  assert.ok(calls.selects[0].title.includes("Which?"));
  assert.ok(calls.selects[0].title.includes("choose one"));
  assert.deepEqual(calls.selects[0].options.slice(0, 2), ["one — first option", "two"]);
});

test("rpc: skip and custom-text options are offered and map to skipped/custom kinds", async () => {
  const { payload } = await executeRpc(
    [{ tab: "a", header: "Q1", options: [{ label: "one" }] }, { tab: "b", header: "Q2", allowSkip: false, options: [{ label: "red" }] }],
    { select: ["→ Skip this question", "✎ Type something…"], input: ["my own words"] },
  );

  assert.deepEqual(payload.answers, [
    { tab: "a", skipped: true },
    { tab: "b", custom: "my own words" },
  ]);
});

test("rpc: cancelling a select cancels the whole call like Esc in the panel", async () => {
  const { payload } = await executeRpc(
    [{ tab: "x", header: "Q", options: [{ label: "one" }] }],
    { select: [undefined] },
  );

  assert.deepEqual(payload, { cancelled: true, answers: [] });
});

test("rpc: dismissed free-text input returns to the option menu, not an error", async () => {
  const { payload, calls } = await executeRpc(
    [{ tab: "x", header: "Q", options: [{ label: "one" }] }],
    { select: ["✎ Type something…", "one"], input: [undefined] },
  );

  assert.deepEqual(payload, { cancelled: false, answers: [{ tab: "x", answer: "one" }] });
  assert.equal(calls.selects.length, 2);
});

test("rpc: multiSelect degrades to inclusion confirms; all-no commits empty answers", async () => {
  const { payload, calls } = await executeRpc(
    [{ tab: "m", header: "Features", multiSelect: true, prompt: "which ones", options: [
      { label: "alpha", description: "the alpha" },
      { label: "beta" },
    ] }],
    { confirm: [true, false] },
  );

  assert.deepEqual(payload.answers, [{ tab: "m", answers: ["alpha"] }]);
  assert.equal(calls.confirms.length, 2);
  assert.ok(calls.confirms[0].title.includes('include "alpha"?'));
  assert.equal(calls.confirms[0].message, "the alpha");
});

test("rpc: note is probed only after the host proved it answers text inputs", async () => {
  // Host proves input() works by answering a "Type something…" flow first;
  // the note probe then fires once at review time.
  const withInput = await executeRpc(
    [{ tab: "x", header: "Q", options: [{ label: "one" }] }],
    { select: ["✎ Type something…"], input: ["typed answer", "a helpful note"] },
  );
  assert.deepEqual(withInput.payload.answers, [{ tab: "x", custom: "typed answer" }]);
  assert.equal(withInput.payload.message, "a helpful note");

  // No successful text input → no extra unsupported-input poll.
  const withoutInput = await executeRpc(
    [{ tab: "x", header: "Q", options: [{ label: "one" }] }],
    { select: ["one"] },
  );
  assert.equal(withoutInput.payload.message, undefined);
  assert.equal(withoutInput.calls.inputs.length, 0);
});
