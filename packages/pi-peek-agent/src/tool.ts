/**
 * pi-peek-agent tool — exposes cross-instance peek to the main agent (LLM).
 *
 * One tool: peek({ question, at?, sessionId? }) asks a peer a question.
 * `question` is required (enforced by schema). Peer discovery moved to
 * @d3ara1n/pi-mesh (its `mesh_list` tool) — resolvePeer/connect come from there.
 *
 * Rendering follows the built-in tool convention: the call cell already shows
 * the tool name, so renderResult MUST NOT repeat it. Collapsed shows the first
 * line of the answer; expanded shows the original question (read from
 * ToolRenderContext.args, which pi shares across call/result renders for one
 * tool call) above the full answer, so the whole exchange is visible when
 * expanded.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getMeshAPI } from "@d3ara1n/pi-mesh";
import type { PeerInfo } from "@d3ara1n/pi-mesh";
import { loadPeekConfig } from "./config.ts";
import { ASK_TYPE } from "./types.ts";
import type { AskResponseData } from "./types.ts";

/** Build a tool result (AgentToolResult requires a `details` field). */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined as unknown,
    isError,
  };
}

export function registerPeekTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "peek",
    label: "Peek at another instance",
    description:
      "Peek at another pi instance — observe its session without disturbing it. " +
      "The peer is never notified; the answer is drawn from what that instance has said and done so far. " +
      "Use for checking progress, confirming details, or asking how something works. " +
      "Use mesh_list first to discover names.",
    promptSnippet: "Observe another pi instance's session without disturbing it",

    parameters: Type.Object({
      question: Type.String({
        description:
          "What you want to find out about that instance's session (e.g. 'What are you working on right now?').",
      }),
      at: Type.Optional(
        Type.String({
          description:
            "Target instance name (e.g. 'Fox'). Omit to auto-pick the other same-project instance.",
        }),
      ),
      sessionId: Type.Optional(
        Type.String({
          description: "Pin a specific instance by sessionId (use when names collide).",
        }),
      ),
    }),

    // Call cell: tool name + target. The answer appears in the result cell.
    renderCall(args, theme) {
      const target = (args as any).at ? ` → ${(args as any).at}` : " → (auto)";
      return new Text(theme.fg("toolTitle", theme.bold("peek")) + theme.fg("accent", target), 0, 0);
    },

    // Result cell: NO tool name. Collapsed = first line of the answer; expanded = question + full answer.
    renderResult(result, { expanded }, theme, context) {
      const isError = context.isError;
      const isPartial = context.isPartial;
      const icon = isPartial
        ? theme.fg("warning", "⏳")
        : isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";

      if (expanded) {
        const c = new Container();
        // The question asked (shared across call/result renders for this tool
        // call via ToolRenderContext.args). Surfaced above the answer so the
        // full Q&A exchange is visible when expanded.
        const question =
          typeof context.args?.question === "string" ? context.args.question : "";
        if (question.trim()) {
          c.addChild(
            new Text(
              theme.fg("accent", theme.bold("Q")) +
                theme.fg("dim", "  ") +
                theme.fg("muted", question),
              0,
              0,
            ),
          );
          c.addChild(new Text("", 0, 0));
        }
        for (const ln of text.split("\n")) {
          c.addChild(new Text(isError ? theme.fg("error", ln) : ln, 0, 0));
        }
        return c;
      }
      // Collapsed: width-aware single-line summary — truncated with "…" when it overflows
      // the viewport, instead of a fixed 100-char hard cut that still wraps on narrow terminals.
      const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
      const styled =
        `${icon} ${isError ? theme.fg("error", firstLine) : theme.fg("dim", firstLine)}`;
      return {
        render: (width: number) => [truncateToWidth(styled, width, "…", true)],
        invalidate: () => {},
      } satisfies Component;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const mesh = getMeshAPI();
      const resolved = await mesh.resolvePeer({
        at: params.at,
        sessionId: params.sessionId,
      });

      if (!resolved) {
        return textResult(
          params.at
            ? `No online peer named '${params.at}'. Call mesh_list to see who's online.`
            : "No other pi instance available to peek.",
          true,
        );
      }

      // Name collision → return candidates so the LLM disambiguates with sessionId.
      if (Array.isArray(resolved)) {
        const cands = resolved
          .map(
            (p) =>
              `- ${p.name} · sessionId=${p.sessionId} · ${p.gitBranch ?? "(no branch)"} · ${p.cwd}`,
          )
          .join("\n");
        return textResult(
          `Multiple instances named '${params.at}'. Specify sessionId to pin one:\n${cands}`,
        );
      }

      const peer = resolved as PeerInfo;
      const cfg = loadPeekConfig(ctx?.cwd);
      try {
        const conn = await mesh.connect(peer);
        try {
          const result = await conn.request(
            ASK_TYPE,
            { question: params.question },
            { signal, timeoutMs: cfg.askTimeoutMs },
          );
          const answer = (result as AskResponseData | undefined)?.answer ?? "";
          return textResult(answer);
        } finally {
          conn.close();
        }
      } catch (err) {
        return textResult(
          `peek ${peer.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  });
}
