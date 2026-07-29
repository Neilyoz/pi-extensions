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
