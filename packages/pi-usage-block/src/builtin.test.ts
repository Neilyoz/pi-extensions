import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_PROVIDERS } from "./builtin.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function tokenFor(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.signature`;
}

test("OpenAI Codex polls the ChatGPT usage endpoint and maps both quota windows", async () => {
  const token = tokenFor("account-123");
  let requestUrl = "";
  let requestHeaders: HeadersInit | undefined;

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestHeaders = init?.headers;
    return new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 42, reset_at: 1_900_000_000 },
        secondary_window: { used_percent: 7.5, reset_at: 1_900_100_000 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai-codex");
  assert.ok(definition);
  const provider = definition.build({
    apiKey: token,
    resolveApiKey: async () => token,
  });

  assert.equal(provider.id, "openai-codex");
  assert.equal(provider.source, "api");
  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);

  const windows = await provider.fetchUsage();
  assert.deepEqual(windows, [
    { period: "primary", used: 42, limit: 100, unit: "tokens", resetAt: new Date(1_900_000_000 * 1000) },
    { period: "secondary", used: 7.5, limit: 100, unit: "tokens", resetAt: new Date(1_900_100_000 * 1000) },
  ]);
  assert.equal(requestUrl, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(new Headers(requestHeaders).get("authorization"), `Bearer ${token}`);
  assert.equal(new Headers(requestHeaders).get("chatgpt-account-id"), "account-123");
});

test("OpenAI Codex refreshes its OAuth token before each usage poll", async () => {
  const initialToken = tokenFor("initial-account");
  const refreshedToken = tokenFor("refreshed-account");
  let resolved = 0;
  let accountHeader = "";

  globalThis.fetch = (async (_input, init) => {
    accountHeader = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
    return new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 1 } },
    }), { status: 200 });
  }) as typeof fetch;

  const definition = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai-codex");
  assert.ok(definition);
  const provider = definition.build({
    apiKey: initialToken,
    resolveApiKey: async () => {
      resolved++;
      return refreshedToken;
    },
  });

  assert.equal(provider.kind, "quota");
  assert.ok(provider.fetchUsage);
  await provider.fetchUsage();
  assert.equal(resolved, 1);
  assert.equal(accountHeader, "refreshed-account");
});
