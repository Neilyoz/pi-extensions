/**
 * Mesh LLM tools — make pi-mesh self-sufficient.
 *
 * With mesh alone (no peek-agent, no chat-room), an agent can discover who else
 * is online, read a peer's self-declared role, and declare its own role. These
 * three tools are the "navigation + self-introduction" surface of the mesh;
 * contacting a peer (peek, message, …) is a consumer plugin's job.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { tryGetMeshAPI } from "./api.ts";
import type { MeshListDetails } from "./types.ts";

/** Parse mesh_list output back into peer names for the collapsed summary. */
function parsePeerNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s+(\S+)/);
    if (m) names.push(m[1]!);
  }
  return names;
}

export function registerMeshTools(pi: ExtensionAPI): void {
  // ── mesh_list — discover online peers ──────────────────────────────────
  pi.registerTool({
    name: "mesh_list",
    label: "List mesh peers",
    description:
      "List other pi instances currently online on the agent mesh, with each peer's name, working directory (cwd), model, git branch, and self-declared role/description (if any). Same-project peers (same cwd) are listed first — the cwd tells you whether a peer shares your codebase.",
    promptSnippet: "Discover other pi agents on the mesh",
    promptGuidelines: [
      "Use mesh_list to see which other agents are online and their self-declared roles before deciding who to contact.",
    ],
    parameters: Type.Object({}),

    // Call cell: tool name (the summary appears in the result cell).
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("mesh_list")), 0, 0);
    },

    // Result cell: NO tool name (call already shows it). Collapsed = width-aware
    // name summary; expanded = per-peer coloring from the structured details:
    // name (accent) → role (text) → branch/model (dim) → cwd/description (muted),
    // with ambiguity warnings in `warning` so they can't be missed.
    renderResult(result, { expanded }, theme, context) {
      const isError = context.isError;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";

      if (expanded) {
        const peers = (result.details as MeshListDetails | undefined)?.peers;
        if (!peers || peers.length === 0) {
          // No structured peers (error result, empty mesh) — dump text lines as-is.
          const c = new Container();
          for (const ln of text.split("\n")) c.addChild(new Text(ln, 0, 0));
          return c;
        }
        const c = new Container();
        c.addChild(new Text(theme.fg("text", `Online peers (${peers.length}):`), 0, 0));
        for (const p of peers) {
          // Line 1: identity — name is the scan target, role the selection cue.
          let line1 = theme.fg("accent", p.name);
          if (p.profile?.role) line1 += ` ${theme.fg("text", `[${p.profile.role}]`)}`;
          if (p.gitBranch) line1 += ` ${theme.fg("dim", `(${p.gitBranch})`)}`;
          if (p.ambiguous) line1 += ` ${theme.fg("warning", "⚠ ambiguous name")}`;
          line1 += ` ${theme.fg("dim", `· ${p.model}`)}`;
          // Line 2: context — long secondary text.
          let line2 = `    ${theme.fg("muted", p.cwd)}`;
          if (p.profile?.description) line2 += theme.fg("muted", ` — ${p.profile.description}`);
          c.addChild(new Text(`- ${line1}`, 0, 0));
          c.addChild(new Text(line2, 0, 0));
          if (p.ambiguous) {
            c.addChild(
              new Text(
                `    ${theme.fg("warning", `sessionId: ${p.sessionId} (use this to target)`)}`,
                0,
                0,
              ),
            );
          }
        }
        return c;
      }
      const names = parsePeerNames(text);
      const styled =
        names.length === 0
          ? `${icon} ${text.split("\n")[0] ?? ""}`
          : `${icon} ${theme.fg(
              "dim",
              names.length <= 5
                ? names.join(", ")
                : `${names.slice(0, 5).join(", ")} +${names.length - 5} more`,
            )}`;
      return {
        render: (width: number) => [truncateToWidth(styled, width, "…", true)],
        invalidate: () => {},
      } satisfies Component;
    },

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const api = tryGetMeshAPI();
      if (!api) throw new Error("mesh not initialized");
      const peers = await api.listPeers();
      if (peers.length === 0) {
        return {
          content: [
            { type: "text", text: "No other pi instances online on the mesh right now." },
          ],
          details: { peers: [] } satisfies MeshListDetails,
        };
      }
      const lines = peers.map((p) => {
        const role = p.profile?.role ? ` [${p.profile.role}]` : "";
        const branch = p.gitBranch ? ` (${p.gitBranch})` : "";
        const ambig = p.ambiguous ? " ⚠ ambiguous name" : "";
        const desc = p.profile?.description ? ` — ${p.profile.description}` : "";
        const sid = p.ambiguous ? `\n    sessionId: ${p.sessionId} (use this to target)` : "";
        // Two lines per peer: identity on line 1, cwd (long) on line 2.
        return `- ${p.name}${role}${branch}${ambig} · ${p.model}\n    ${p.cwd}${desc}${sid}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `Online peers (${peers.length}):\n${lines.join("\n")}`,
          },
        ],
        details: { peers } satisfies MeshListDetails,
      };
    },
  });

  // ── mesh_get_profile — read a peer's (or own) role/description ─────────
  pi.registerTool({
    name: "mesh_get_profile",
    label: "Get peer profile",
    description:
      "Read a peer's self-declared profile (role + description) and basic identity (name, model, cwd). Omit `name` to read your own profile.",
    promptGuidelines: [
      "Use mesh_get_profile to learn what a peer specializes in before contacting them.",
    ],
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            "Name of the peer to look up (as shown by mesh_list). Omit to read your own profile.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const api = tryGetMeshAPI();
      if (!api) throw new Error("mesh not initialized");

      let target;
      if (!params.name) {
        target = api.getSelfInfo();
      } else {
        const resolved = await api.resolvePeer({ at: params.name });
        if (!resolved) {
          throw new Error(`No online peer named "${params.name}".`);
        }
        if (Array.isArray(resolved)) {
          throw new Error(
            `Name "${params.name}" is ambiguous (${resolved.length} peers). Target by a different name or session id.`,
          );
        }
        target = resolved;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                name: target.name,
                role: target.profile?.role ?? null,
                description: target.profile?.description ?? null,
                model: target.model,
                cwd: target.cwd,
                gitBranch: target.gitBranch ?? null,
              },
              null,
              2,
            ),
          },
        ],
        details: {},
      };
    },
  });

  // ── mesh_set_profile — declare / update own role ───────────────────────
  pi.registerTool({
    name: "mesh_set_profile",
    label: "Set own profile",
    description:
      "Declare or update THIS instance's role and description on the mesh — the 'name card' other agents see via mesh_list / mesh_get_profile. Pass an empty string to clear a field. This is how you self-introduce: e.g. role='security lead', description='auth/crypto/injection audits'.",
    promptGuidelines: [
      "Use mesh_set_profile to announce your role so other agents know when to consult you; keep role short and description specific.",
    ],
    parameters: Type.Object({
      role: Type.Optional(
        Type.String({ description: "Short role/title, e.g. 'security lead', 'frontend designer'." }),
      ),
      description: Type.Optional(
        Type.String({
          description: "Specialties / when-to-consult detail. Empty string clears it.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const api = tryGetMeshAPI();
      if (!api) throw new Error("mesh not initialized");
      if (params.role === undefined && params.description === undefined) {
        throw new Error("Provide at least one of `role` or `description`.");
      }
      api.setProfile({ role: params.role, description: params.description });
      const p = api.getProfile();
      const summary = `role=${p?.role ?? "(none)"} description=${p?.description ?? "(none)"}`;
      return {
        content: [{ type: "text", text: `Profile updated — ${summary}` }],
        details: {},
      };
    },
  });
}
