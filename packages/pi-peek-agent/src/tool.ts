/**
 * pi-peek-agent tool — exposes cross-instance peek to the main agent (LLM).
 *
 * One tool: peek({ question, at?, sessionId? }) asks a peer a question.
 * `question` is required (enforced by schema). Peer discovery moved to
 * @d3ara1n/pi-mesh (its `mesh_list` tool) — resolvePeer/connect come from there.
 *
 * Rendering follows the built-in tool convention: the call cell already shows
 * the tool name, so renderResult MUST NOT repeat it — it only renders the
 * result body (collapsed = first line, expanded = full).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
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
      "Peek at another pi instance — ask it a question without disturbing its main conversation. " +
      "The peeked instance's main agent is completely unaffected; the answer comes from its side " +
      "utility model (read-after-burn). Use for cross-instance coordination: check progress, " +
      "confirm details, ask how something works. Use mesh_list first to discover names.",
    promptSnippet: "Ask another pi instance a question without disturbing it (cross-instance peek)",

    parameters: Type.Object({
      question: Type.String({
        description: "The question to ask the other instance.",
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

    // Result cell: NO tool name. Collapsed = first line of the answer.
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
        for (const ln of text.split("\n")) {
          c.addChild(new Text(isError ? theme.fg("error", ln) : ln, 0, 0));
        }
        return c;
      }
      // Collapsed: first non-empty line, truncated. No tool name prefix.
      const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
      const body = isError
        ? theme.fg("error", firstLine.slice(0, 100))
        : theme.fg("dim", firstLine.slice(0, 100));
      return new Text(`${icon} ${body}`, 0, 0);
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
