/**
 * Side agent invocation for session naming.
 *
 * Calls the side agent via model-roles' completeWithRole() (auth resolved internally)
 * and returns a cleaned session name string.
 */

import type { ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { SessionNamerConfig } from "./types.ts";

/** Hard timeout for the naming side agent (ms). A short title needs ~dozens of tokens. */
const NAMER_TIMEOUT_MS = 10_000;

/** Character budget for the packed exchange, excluding the wrapper tags. */
const PROMPT_BUDGET_CHARS = 2000;

/**
 * Truncate a single field to fit the prompt budget, always leaving the XML
 * wrapper tags closed. Truncating the packed prompt as a whole could cut
 * inside a tag, leaving it unclosed — models then continue the pattern and
 * echo the tag instead of summarizing.
 */
function truncateField(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return budget <= 3 ? text.slice(0, budget) : text.slice(0, budget - 3) + "...";
}

/** The opening exchange used to name a session. */
export interface NamingExchange {
  user: string;
  assistant?: string;
}

/**
 * Build the system prompt for the naming side agent.
 */
export function buildNamerSystemPrompt(maxLength: number): string {
  return [
    `You are a session naming assistant. Generate a concise title for a coding session based on the first exchange (the user's opening message and the assistant's first reply).`,
    ``,
    `Rules:`,
    `- Output in the SAME language as the user's message`,
    `- Maximum ${maxLength} characters`,
    `- Output ONLY the title, no quotes, no prefix, no explanation`,
    `- The input wraps the user's message in <user_message> and the assistant's reply in <assistant_reply>; name the session after the user's intent`,
    `- Summarize the user's intent; do not copy any message verbatim`,
    `- Reflect what the session is about, not the latest progress`,
    `- If the exchange mentions specific files, modules, or functions, keep those names`,
    `- Be specific: "Fix auth token refresh bug" is better than "Fix a bug"`,
  ].join("\n");
}

/**
 * Call the side agent to generate a session name.
 */
export async function generateSessionName(
  rolesApi: ModelRolesAPI,
  roleName: string,
  config: SessionNamerConfig,
  exchange: NamingExchange,
): Promise<string> {
  const systemPrompt = buildNamerSystemPrompt(config.maxLength);

  // Pack the exchange into a single user message: the side agent only needs to
  // read the opening exchange, not replay it as conversation history. Fields
  // are truncated individually so the wrapper tags always stay closed.
  const user = truncateField(exchange.user, PROMPT_BUDGET_CHARS);
  const assistant = exchange.assistant?.trim()
    ? truncateField(exchange.assistant, PROMPT_BUDGET_CHARS)
    : undefined;
  const promptText = assistant
    ? `<user_message>\n${user}\n</user_message>\n\n<assistant_reply>\n${assistant}\n</assistant_reply>`
    : `<user_message>\n${user}\n</user_message>`;

  const signal = AbortSignal.timeout(NAMER_TIMEOUT_MS);
  const result = await rolesApi.completeWithRole(
    roleName,
    {
      systemPrompt,
      messages: [{ role: "user", content: promptText, timestamp: Date.now() }],
    },
    { signal },
  );

  // Surface upstream errors explicitly so callers can notify. pi-ai returns
  // provider rejections as stopReason "error" + errorMessage with empty
  // content, which would otherwise silently degrade to "New session".
  if (result.stopReason === "error" || result.errorMessage) {
    throw new Error(result.errorMessage || "side agent returned an error");
  }

  const raw =
    result.content
      ?.filter((block: any) => block.type === "text")
      ?.map((block: any) => block.text)
      ?.join("")
      ?.trim() ?? "";

  if (!raw) {
    throw new Error("side agent returned empty content");
  }

  return cleanSessionName(raw, config.maxLength);
}

/**
 * Clean and truncate the generated name.
 * Strips common model prefixes ("Here is a title:", "Title:", etc.)
 * so the output can be used directly.
 */
function cleanSessionName(raw: string, maxLength: number): string {
  let name = raw.trim();
  if (!name) return "New session";

  // Strip common model prefixes that slip through
  name = name.replace(/^(here is (a |the )?(title|name)[：:]\s*)/i, "");
  name = name.replace(/^(title|name|session)[：:]\s*/i, "");

  // Strip surrounding quotes if present
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'")) ||
    (name.startsWith("「") && name.endsWith("」"))
  ) {
    name = name.slice(1, -1);
  }

  // Remove newlines
  name = name.replace(/\n/g, " ").trim();

  // Truncate only when a positive limit is configured. For limits shorter
  // than an ellipsis, preserve the hard maximum instead of overflowing it.
  if (maxLength > 0 && name.length > maxLength) {
    name = maxLength <= 3 ? name.slice(0, maxLength) : name.slice(0, maxLength - 3) + "...";
  }

  return name || "New session";
}
