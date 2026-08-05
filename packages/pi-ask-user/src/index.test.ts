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
  const prevAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = tmpDir;
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
    if (prevAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = prevAgentDir;
  }
});
