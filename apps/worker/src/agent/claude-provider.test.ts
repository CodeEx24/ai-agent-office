import { describe, expect, it } from "vitest";

import { ANTHROPIC_MESSAGES_URL, createClaudeProvider, scrubApiKey } from "./claude-provider.js";
import { ModelProviderError } from "./model-provider.js";

import type { ModelRequest } from "./model-provider.js";

// A fake fetch only: no test in this file makes a real API call.
const KEY = "sk-ant-api03-FAKE-KEY-provider-0123456789";

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "trusted system text",
  messages: [{ role: "user", content: "do the task" }],
  tools: [{ name: "get_current_time", description: "time", inputSchema: { type: "object" } }],
  maxOutputTokens: 256,
  signal: new AbortController().signal,
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Claude provider (fake fetch only)", () => {
  it("sends the Messages API request shape, with the key only in the x-api-key header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const provider = createClaudeProvider({
      apiKey: KEY,
      model: "claude-sonnet-5-5",
      fetch: (url, init) => {
        seen.push({ url: typeof url === "string" ? url : "(not a string)", init: init ?? {} });
        return Promise.resolve(
          json({
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        );
      },
    });

    await provider.complete(request());

    expect(seen[0]?.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(seen[0]?.init.headers).toMatchObject({
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    });
    const sentBody = typeof seen[0]?.init.body === "string" ? seen[0].init.body : "";
    const body = JSON.parse(sentBody) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 256,
      system: "trusted system text",
      messages: [{ role: "user", content: "do the task" }],
      tools: [{ name: "get_current_time", description: "time", input_schema: { type: "object" } }],
    });
    expect(sentBody).not.toContain(KEY);
  });

  it("parses text and tool_use blocks and usage, ignoring block types it does not know", async () => {
    const provider = createClaudeProvider({
      apiKey: KEY,
      model: "m",
      fetch: () =>
        Promise.resolve(
          json({
            content: [
              { type: "thinking", thinking: "..." },
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "toolu_9", name: "get_current_time", input: { a: 1 } },
            ],
            usage: { input_tokens: 11, output_tokens: 4 },
          }),
        ),
    });

    const response = await provider.complete(request());

    expect(response).toEqual({
      text: "Let me check.",
      toolCalls: [{ id: "toolu_9", name: "get_current_time", input: { a: 1 } }],
      usage: { inputTokens: 11, outputTokens: 4 },
    });
  });

  it("marks rate limits and server errors retryable, and other failures not, without echoing the key", async () => {
    const failWith = (status: number, body: string) =>
      createClaudeProvider({
        apiKey: KEY,
        model: "m",
        fetch: () => Promise.resolve(new Response(body, { status })),
      }).complete(request());

    for (const status of [429, 500, 529]) {
      const error = await failWith(status, "slow down").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as ModelProviderError).isRetryable).toBe(true);
    }
    const bad = await failWith(401, `bad key ${KEY}`).catch((e: unknown) => e);
    expect((bad as ModelProviderError).isRetryable).toBe(false);
    expect((bad as ModelProviderError).message).not.toContain(KEY);
  });

  it("never keeps the provider's error body: only the status and a fixed category", async () => {
    const oddKey = "plainly-custom-key-value-1234";
    const provider = createClaudeProvider({
      apiKey: oddKey,
      model: "m",
      fetch: () => Promise.resolve(new Response(`rejected: ${oddKey}`, { status: 400 })),
    });

    const error = await provider.complete(request()).catch((e: unknown) => e);

    expect((error as Error).message).toBe("model request failed with status 400 (invalid_request)");
  });

  it("scrubApiKey removes the key in raw, base64, base64url, hex and URL-encoded forms", () => {
    const key = "plainly custom/key+value=1234";
    const bytes = Buffer.from(key);
    const forms = [
      key,
      bytes.toString("base64"),
      bytes.toString("base64").replace(/=+$/, ""),
      bytes.toString("base64url"),
      bytes.toString("hex"),
      bytes.toString("hex").toUpperCase(),
      encodeURIComponent(key),
    ];

    const cleaned = scrubApiKey(forms.join(" | "), key);

    for (const form of forms) expect(cleaned).not.toContain(form);
  });

  it("rejects a response that is not in the expected shape", async () => {
    const provider = createClaudeProvider({
      apiKey: KEY,
      model: "m",
      fetch: () => Promise.resolve(json({ unexpected: true })),
    });

    await expect(provider.complete(request())).rejects.toThrow("expected shape");
  });

  it("hides network error details (they can carry request data) and keeps abort errors as they are", async () => {
    const network = createClaudeProvider({
      apiKey: KEY,
      model: "m",
      fetch: () => Promise.reject(new Error(`connect failed with header x-api-key: ${KEY}`)),
    });
    const failure = await network.complete(request()).catch((e: unknown) => e);
    expect((failure as Error).message).toBe("model request failed");

    const controller = new AbortController();
    controller.abort();
    const aborted = createClaudeProvider({
      apiKey: KEY,
      model: "m",
      fetch: () => Promise.reject(new Error("aborted")),
    });
    await expect(aborted.complete(request({ signal: controller.signal }))).rejects.toThrow(
      "aborted",
    );
  });

  it("refuses to be created without a key", () => {
    expect(() => createClaudeProvider({ apiKey: "  ", model: "m" })).toThrow("API key");
  });
});
