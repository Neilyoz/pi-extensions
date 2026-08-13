/**
 * pi-chat-room — Extension entry point.
 *
 * Agent-to-agent messaging on @d3ara1n/pi-mesh. Exposes the `send_to` tool and
 * serves incoming `message` requests by injecting them as user messages prefixed
 * `[From: NAME]`, delivered per the `chatRoom.deliveryMode` setting — "steer"
 * (default) injects them at the next safe point mid-turn; "followUp" queues
 * them until the agent finishes its turn.
 *
 * Role-agnostic: it does not know "assistant" or "director" — it just delivers
 * bytes between named peers. Roles are declared via pi-mesh's mesh_set_profile.
 * Order-agnostic: load order vs pi-mesh is irrelevant (mesh:ready event +
 * tryGetMeshAPI fallback), mirroring pi-peek-agent's pattern.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MESH_READY_EVENT, tryGetMeshAPI } from "@d3ara1n/pi-mesh";
import type { MeshAPI } from "@d3ara1n/pi-mesh";
import { registerChatRoomTools } from "./tools.ts";
import { MESSAGE_TYPE } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import type { ChatRoomConfig } from "./types.ts";
import type { MessageAck, MessageRequestData } from "./types.ts";
import { loadConfig } from "./config.ts";

export default function registerChatRoomExtension(pi: ExtensionAPI): void {
  let registered = false;
  let config: ChatRoomConfig = DEFAULT_CONFIG;

  // Serve incoming messages: inject as a user message prefixed with the sender,
  // using the configured delivery mode. Config is read at message time — startup
  // always completes before any message arrives, so the mesh:ready path below
  // never needs to touch it. Returns immediately (delivery ack).
  function serveMessages(mesh: MeshAPI): void {
    if (registered) return;
    registered = true;
    mesh.serve(MESSAGE_TYPE, async (data, _emit) => {
      const { from, text } = (data ?? {}) as MessageRequestData;
      const sender = from || "unknown";
      const body = `[From: ${sender}] ${text ?? ""}`.trim();
      pi.sendUserMessage(body, { deliverAs: config.deliveryMode });
      return { delivered: true } satisfies MessageAck;
    });
  }

  // Order-agnostic: catch mesh init whether it fires before or after our load.
  // (a) mesh inits AFTER us → its session_start emits mesh:ready, we catch it.
  pi.events.on(MESH_READY_EVENT, (mesh: unknown) => serveMessages(mesh as MeshAPI));

  // (b) mesh inits BEFORE us, or in the same session_start pass → already on globalThis.
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    const mesh = tryGetMeshAPI();
    if (!mesh) return; // waiting for the mesh:ready listener to fire
    serveMessages(mesh);
  });

  registerChatRoomTools(pi);
}
