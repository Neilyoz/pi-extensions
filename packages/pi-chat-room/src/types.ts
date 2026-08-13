/**
 * pi-chat-room shared types — the "message" channel carried over the mesh.
 *
 * Discovery, transport, and identity are @d3ara1n/pi-mesh's job; this package
 * only defines its own request type and wire payload.
 */

/** Mesh request type string for a chat-room message. */
export const MESSAGE_TYPE = "message";

/** Wire payload of an incoming/outgoing message. */
export interface MessageRequestData {
  /** Sender's mesh identity name. */
  from: string;
  /** Message body. */
  text: string;
}

/** Acknowledgement returned once the recipient has queued the message locally. */
export interface MessageAck {
  delivered: boolean;
}

/** Delivery mode for incoming messages, set via the `chatRoom` settings block. */
export type DeliveryMode = "steer" | "followUp";

/** User-facing chatRoom configuration. */
export interface ChatRoomConfig {
  /**
   * How incoming messages are delivered to the agent. `"steer"` (default)
   * injects them at the next safe point while the agent is mid-turn;
   * `"followUp"` queues them until the agent finishes its turn.
   */
  deliveryMode: DeliveryMode;
}

/** Built-in defaults, used when a setting is absent or invalid. */
export const DEFAULT_CONFIG: ChatRoomConfig = {
  deliveryMode: "steer",
};
