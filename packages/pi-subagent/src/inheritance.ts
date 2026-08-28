/**
 * Deterministic, text-only serialization of an active pi session branch for
 * optional subagent conversation inheritance.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const OMISSION_MARKER = "[Earlier inherited conversation omitted for length.]";
const MESSAGE_OMISSION_MARKER = "[Earlier text in this message omitted.]";

type EntryLike = {
  type?: unknown;
  summary?: unknown;
  message?: unknown;
  retainedTail?: unknown;
};

type MessageLike = {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
};

type Chunk = {
  kind: "summary" | "dialogue";
  text: string;
};

export interface InheritedConversationSnapshot {
  /** Delimiter-safe text delivered to the child. */
  text: string;
  /** True when eligible inherited content was omitted to satisfy maxChars. */
  truncated: boolean;
}

/** Keep inherited text from being interpreted as one of the surrounding prompt tags. */
function escapePromptText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function textContent(content: unknown): string {
  if (typeof content === "string") return escapePromptText(content);
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const block = part as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string"
        ? [escapePromptText(block.text)]
        : [];
    })
    .join("");
}

function serializeMessage(message: unknown): Chunk | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { role, content, summary } = message as MessageLike;
  if (role === "user" || role === "assistant") {
    const text = textContent(content);
    return text ? { kind: "dialogue", text: `[${role}]\n${text}` } : undefined;
  }
  if (role === "compactionSummary" && typeof summary === "string" && summary) {
    return {
      kind: "summary",
      text: `[Compaction summary]\n${escapePromptText(summary)}`,
    };
  }
  if (role === "branchSummary" && typeof summary === "string" && summary) {
    return { kind: "summary", text: `[Branch summary]\n${escapePromptText(summary)}` };
  }
  return undefined;
}

function truncateDialogueChunk(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const newline = text.indexOf("\n");
  const label = newline >= 0 ? text.slice(0, newline) : "[message]";
  const prefix = `${label}\n${MESSAGE_OMISSION_MARKER}\n`;
  if (prefix.length >= maxChars) return prefix.slice(0, maxChars);
  return prefix + text.slice(text.length - (maxChars - prefix.length));
}

/** Select newest complete dialogue chunks, truncating only the newest chunk as a last resort. */
function newestDialogue(chunks: Chunk[], maxChars: number): string {
  if (maxChars <= 0 || chunks.length === 0) return "";
  const selected: string[] = [];
  let used = 0;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const separator = selected.length > 0 ? 2 : 0;
    const remaining = maxChars - used - separator;
    if (remaining <= 0) break;
    const text = chunks[i].text;
    if (text.length <= remaining) {
      selected.unshift(text);
      used += separator + text.length;
      continue;
    }
    selected.unshift(truncateDialogueChunk(text, remaining));
    break;
  }
  return selected.join("\n\n");
}

/**
 * Serialize the supplied active, compaction-aware session entries in order.
 * Only compaction/branch summaries and user/assistant text are retained.
 */
export function serializeInheritedConversation(
  entries: SessionEntry[],
  maxChars: number,
): InheritedConversationSnapshot {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (limit === 0) return { text: "", truncated: false };
  const chunks: Chunk[] = [];

  const addMessage = (message: unknown) => {
    const serialized = serializeMessage(message);
    if (serialized) chunks.push(serialized);
  };

  for (const rawEntry of entries) {
    const entry = rawEntry as EntryLike;
    if (entry.type === "compaction") {
      if (typeof entry.summary === "string" && entry.summary) {
        chunks.push({
          kind: "summary",
          text: `[Compaction summary]\n${escapePromptText(entry.summary)}`,
        });
      }
      // Newer compaction entries materialize their kept context here. The
      // installed firstKeptEntryId shape returns those entries separately.
      if (Array.isArray(entry.retainedTail)) {
        for (const message of entry.retainedTail) addMessage(message);
      }
      continue;
    }
    if (entry.type === "branch_summary") {
      if (typeof entry.summary === "string" && entry.summary) {
        chunks.push({
          kind: "summary",
          text: `[Branch summary]\n${escapePromptText(entry.summary)}`,
        });
      }
      continue;
    }
    if (entry.type === "message") addMessage(entry.message);
  }

  const full = chunks.map((chunk) => chunk.text).join("\n\n");
  if (full.length <= limit) return { text: full, truncated: false };

  const summaryText = chunks
    .filter((chunk) => chunk.kind === "summary")
    .map((chunk) => chunk.text)
    .join("\n\n");
  const dialogueChunks = chunks.filter((chunk) => chunk.kind === "dialogue");
  const dialogueText = dialogueChunks.map((chunk) => chunk.text).join("\n\n");

  // Reserve an explicit marker, then retain summary context plus the newest
  // dialogue. Start with a 40/60 split, but redistribute every unused char so
  // a short side never wastes capacity. This is deterministic and model-free.
  const hasSummary = summaryText.length > 0;
  const hasDialogue = dialogueText.length > 0;
  const separatorChars = (hasSummary ? 2 : 0) + (hasDialogue ? 2 : 0);
  if (limit <= OMISSION_MARKER.length + separatorChars) {
    return { text: OMISSION_MARKER.slice(0, limit), truncated: true };
  }
  const available = limit - OMISSION_MARKER.length - separatorChars;
  let summaryBudget =
    hasSummary && hasDialogue ? Math.floor(available * 0.4) : hasSummary ? available : 0;
  let dialogueBudget = hasDialogue ? available - summaryBudget : 0;

  if (summaryText.length < summaryBudget) {
    dialogueBudget += summaryBudget - summaryText.length;
    summaryBudget = summaryText.length;
  }
  if (dialogueText.length < dialogueBudget) {
    summaryBudget += dialogueBudget - dialogueText.length;
    dialogueBudget = dialogueText.length;
  }

  const selectedSummary = summaryBudget > 0 ? summaryText.slice(0, summaryBudget) : "";
  const selectedDialogue = newestDialogue(dialogueChunks, dialogueBudget);
  return {
    text: [selectedSummary, OMISSION_MARKER, selectedDialogue].filter(Boolean).join("\n\n"),
    truncated: true,
  };
}
