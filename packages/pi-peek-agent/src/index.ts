/**
 * pi-peek-agent — Extension entry point.
 *
 * Cross-instance peek, built on @d3ara1n/pi-mesh. This extension owns only the
 * peek business: it registers an "ask" handler on the mesh (answered via
 * @d3ara1n/pi-peek's local investigate(), read-after-burn) and exposes the
 * `peek` LLM tool. Discovery, transport, identity, and the `mesh_list` tool all
 * live in pi-mesh.
 *
 * Load order is NOT significant: we listen for pi-mesh's `mesh:ready` event
 * (catches mesh init that happens after we load) and fall back to
 * tryGetMeshAPI() in our own session_start (catches mesh init that happened
 * before or in the same pass). So pi-mesh and pi-peek-agent may appear in any
 * order in settings.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPeekAPI } from "@d3ara1n/pi-peek";
import { MESH_READY_EVENT, tryGetMeshAPI } from "@d3ara1n/pi-mesh";
import type { MeshAPI } from "@d3ara1n/pi-mesh";
import { registerPeekTool } from "./tool.ts";
import { ASK_TYPE } from "./types.ts";
import type { AskRequestData, AskResponseData } from "./types.ts";

export default function registerPeekAgentExtension(pi: ExtensionAPI): void {
  let registered = false;

  // Register the "ask" handler on the mesh. Idempotent (guarded by `registered`).
  // peekApi is resolved LAZILY inside the handler — by the time a remote ask
  // arrives, pi-peek's session_start has long since run, so getPeekAPI() is safe
  // there and we don't depend on pi-peek's init timing either.
  function serveAsks(mesh: MeshAPI): void {
    if (registered) return;
    registered = true;
    mesh.serve(ASK_TYPE, async (data, emit) => {
      const { question } = (data ?? {}) as AskRequestData;
      const peekApi = getPeekAPI();
      const { answer } = await peekApi.investigate(question ?? "", {
        onToken: (delta) => emit("token", { delta }),
        onStage: (stage) => emit("stage", { stage }),
      });
      return { answer } satisfies AskResponseData;
    });
  }

  // (a) mesh inits AFTER us → its session_start emits mesh:ready, we catch it.
  pi.events.on(MESH_READY_EVENT, (mesh: unknown) => serveAsks(mesh as MeshAPI));

  // (b) mesh inits BEFORE us, or in the same session_start pass → already on globalThis.
  pi.on("session_start", async (_event, ctx) => {
    const mesh = tryGetMeshAPI();
    if (!mesh) return; // waiting for the mesh:ready listener to fire
    serveAsks(mesh);
    if (ctx.hasUI) {
      ctx.ui.notify("pi-peek-agent ready (serving asks on the mesh)", "info");
    }
  });

  registerPeekTool(pi);
}
