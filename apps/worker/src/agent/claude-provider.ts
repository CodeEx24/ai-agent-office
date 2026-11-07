import { z } from "zod";

import { scrubString } from "../logger.js";

import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";

/**
 * The real Claude provider (AGO-167): the plain Messages API tool loop, over `fetch`.
 *
 * Why the Messages API and not the Claude Agent SDK: the Agent SDK runs its own tool loop and its own
 * permission model, which would put tool execution outside our policy hook. Here the model only
 * proposes tool calls; the loop in agent-loop.ts is the sole place a tool runs. It also adds no
 * dependency (the stack stays locked).
 *
 * Credentials: `apiKey` lives in this closure and is sent only as the `x-api-key` header. It is never
 * put in the request body, an error message or a log line.
 *
 * Not called by any test or CI job: a live check needs the owner's explicit OK (it bills). Tests inject
 * a fake `fetch` to pin the request and response shapes.
 */

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ERROR_BODY_MAX = 200;

export class ModelProviderError extends Error {
  readonly status: number | undefined;
  /** Rate limits, overload and 5xx are worth a retry; a bad request or auth failure is not. */
  readonly isRetryable: boolean;
  constructor(message: string, status: number | undefined, isRetryable: boolean) {
    super(message);
    this.name = "ModelProviderError";
    this.status = status;
    this.isRetryable = isRetryable;
  }
}

export interface ClaudeProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Tests inject a fake; production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly url?: string;
}

const contentBlockSchema = z.looseObject({ type: z.string() });
const responseSchema = z.looseObject({
  content: z.array(contentBlockSchema),
  usage: z.looseObject({ input_tokens: z.number().int(), output_tokens: z.number().int() }),
});
const textBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
const toolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export function createClaudeProvider(options: ClaudeProviderOptions): ModelProvider {
  const { apiKey, model } = options;
  if (apiKey.trim() === "") throw new Error("a model API key is required");
  const doFetch = options.fetch ?? fetch;
  const url = options.url ?? ANTHROPIC_MESSAGES_URL;

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": ANTHROPIC_VERSION,
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }),
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal.aborted) throw error; // the loop decides what an abort means
        throw new ModelProviderError("model request failed", undefined, true);
      }

      if (!response.ok) {
        const body = scrubString(await response.text().catch(() => "")).slice(0, ERROR_BODY_MAX);
        const isRetryable =
          response.status === 429 || response.status === 529 || response.status >= 500;
        throw new ModelProviderError(
          `model request failed with status ${String(response.status)}: ${body}`,
          response.status,
          isRetryable,
        );
      }

      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new ModelProviderError(
          "model response was not in the expected shape",
          undefined,
          false,
        );
      }
      const texts: string[] = [];
      const toolCalls: { id: string; name: string; input: unknown }[] = [];
      for (const block of parsed.data.content) {
        const text = textBlockSchema.safeParse(block);
        if (text.success) {
          texts.push(text.data.text);
          continue;
        }
        const toolUse = toolUseBlockSchema.safeParse(block);
        if (toolUse.success) {
          toolCalls.push({
            id: toolUse.data.id,
            name: toolUse.data.name,
            input: toolUse.data.input,
          });
        }
      }
      return {
        text: texts.join("\n"),
        toolCalls,
        usage: {
          inputTokens: parsed.data.usage.input_tokens,
          outputTokens: parsed.data.usage.output_tokens,
        },
      };
    },
  };
}
