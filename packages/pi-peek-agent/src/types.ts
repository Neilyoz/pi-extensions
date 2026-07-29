/**
 * pi-peek-agent shared types — the peek business layer.
 *
 * Only peek-specific types live here. Peer identity, discovery, and the
 * cross-instance transport moved to @d3ara1n/pi-mesh; import those from there.
 * What remains is the "ask" wire protocol and the ask-timeout config.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PeekConfig {
  /** Synchronous wait timeout for a remote ask. Default 120s. */
  askTimeoutMs?: number;
}

export const DEFAULT_PEEK_CONFIG: Required<Pick<PeekConfig, "askTimeoutMs">> = {
  askTimeoutMs: 120_000,
};

// ---------------------------------------------------------------------------
// "ask" wire protocol (carried over the mesh's "ask" request channel)
// ---------------------------------------------------------------------------

/** Mesh request type string for a peek ask. */
export const ASK_TYPE = "ask";

export interface AskRequestData {
  question: string;
}

export interface AskResponseData {
  answer: string;
}
