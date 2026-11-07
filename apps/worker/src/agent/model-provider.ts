/**
 * The model behind an interface (AGO-167). The tool loop depends only on this seam, so the vendor
 * (Claude today) can change and tests run against a scripted fake with no network and no key.
 *
 * Credentials: a provider owns its own credential. The loop, the context builder, the policy hook,
 * the tools and the event emitter never see one, so there is no path for a key to reach a prompt,
 * a tool input or a run event (AC3).
 */

/** A tool the model may ask for. `inputSchema` is JSON Schema, in the shape the Messages API takes. */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** One tool call the model asked for. `input` is untrusted model output until a tool validates it. */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelRequest {
  /** Trusted text only (from the context builder). */
  readonly system: string;
  readonly messages: readonly { readonly role: "user"; readonly content: string }[];
  readonly tools: readonly ModelToolDefinition[];
  readonly maxOutputTokens: number;
  /** Aborted on shutdown or when the run's wall-time limit is reached. */
  readonly signal: AbortSignal;
}

export interface ModelResponse {
  /** Text the model wrote this step. With no tool calls it is the run's result. */
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: ModelUsage;
}

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
