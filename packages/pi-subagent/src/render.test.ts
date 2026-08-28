/** Tests for inherited-conversation TUI observability. */

import assert from "node:assert/strict";
import test from "node:test";
import { renderBackgroundDelegateCall, renderBackgroundDelegateResult } from "./render-async.ts";
import { renderDelegateCall } from "./render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function rendered(component: { render(width: number): string[] }): string {
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

test("delegate call titles mark inherited conversation without changing isolated mode", () => {
  const isolated = rendered(renderDelegateCall({ role: "worker" } as any, theme, {} as any));
  const inherited = rendered(
    renderDelegateCall({ role: "worker", inheritConversation: true } as any, theme, {} as any),
  );

  assert.equal(isolated, "subagent_delegate worker");
  assert.equal(inherited, "subagent_delegate worker (inherits conversation)");
});

test("background call and expanded input expose only safe inheritance metadata", () => {
  const call = rendered(
    renderBackgroundDelegateCall(
      { role: "worker", background: true, inheritConversation: true } as any,
      theme,
      {} as any,
    ),
  );
  assert.equal(call, "subagent_delegate worker (background · inherits conversation)");

  const result = rendered(
    renderBackgroundDelegateResult(
      {
        content: [{ type: "text", text: "started" }],
        details: {
          id: "sub-1",
          role: "worker",
          task: "Implement the delta",
          context: "explicit context",
          inheritConversation: true,
          inheritedConversationChars: 50_000,
          inheritedConversationTruncated: true,
        },
      } as any,
      { expanded: true, isPartial: false },
      theme,
      {} as any,
    ),
  );

  assert.match(result, /ctx 16 chars/);
  assert.match(result, /conversation 50000 chars · truncated/);
  assert.ok(!result.includes("inherited_conversation"));
});
