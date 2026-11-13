import { secretRefSchema } from "@ago/shared";
import { z } from "zod";

import type { AgentTool, ToolContext } from "../agent/tools.js";
import type { CredentialBroker } from "./credential-broker.js";
import type { CapabilityTier } from "@ago/shared";

/** The input field that carries the reference. Reserved: a tool's own arguments cannot use it. */
export const SECRET_REF_FIELD = "secret_ref";

export interface BrokeredToolOptions<Shape extends z.ZodRawShape> {
  /** Messages API tool name. */
  readonly name: string;
  readonly description: string;
  readonly tier: CapabilityTier;
  /** The catalog capability the agent needs a grant for. Required: the broker checks the credential for it. */
  readonly capabilityKey: string;
  /** The tool's own arguments, besides the secret reference. */
  readonly args: Shape;
  /** JSON Schema `properties` for `args`, shown to the model. Must describe the same shape. */
  readonly modelProperties: Readonly<Record<string, unknown>>;
  readonly modelRequired?: readonly string[];
  readonly broker: CredentialBroker;
  /** The run's agent credential, held by the worker. Never part of the model's input or output. */
  readonly credentialFor: (context: ToolContext) => string | undefined;
  /** Does the work. Gets the secret value and must return text; the broker scrubs it before it leaves. */
  readonly run: (
    args: z.infer<z.ZodObject<Shape>>,
    secret: string,
    context: ToolContext,
  ) => Promise<string>;
}

/**
 * Builds an `AgentTool` whose input is a secret reference plus its own arguments (AGO-157). The model can
 * only name a secret; the value is resolved on the server by the broker, used inside `run`, and scrubbed from
 * what comes back. A raw key in `secret_ref` fails validation, so the tool is not run.
 */
export function createBrokeredTool<Shape extends z.ZodRawShape>(
  options: BrokeredToolOptions<Shape>,
): AgentTool {
  if (SECRET_REF_FIELD in options.args) {
    throw new Error(`"${SECRET_REF_FIELD}" is reserved for the secret reference`);
  }
  const argsSchema = z.strictObject(options.args);
  const referenceSchema = z.looseObject({ secret_ref: secretRefSchema });
  const inputSchema = z.strictObject({ ...options.args, secret_ref: secretRefSchema });

  return {
    name: options.name,
    description: options.description,
    tier: options.tier,
    capabilityKey: options.capabilityKey,
    inputSchema,
    modelInputSchema: {
      type: "object",
      properties: {
        [SECRET_REF_FIELD]: {
          type: "string",
          description:
            "Reference to a stored secret, such as secret:crm_api_key. A reference only: never put a key value here.",
        },
        ...options.modelProperties,
      },
      required: [SECRET_REF_FIELD, ...(options.modelRequired ?? [])],
      additionalProperties: false,
    },
    execute(input, context) {
      // Validate the whole input (strict: no extra field), then split the reference from the arguments.
      inputSchema.parse(input);
      const { secret_ref: secretRef } = referenceSchema.parse(input);
      const { secret_ref: _reference, ...rest } = input as Record<string, unknown>;
      const args = argsSchema.parse(rest);
      return options.broker.withSecret(
        {
          workspaceId: context.workspaceId,
          agentId: context.agentId,
          runId: context.runId,
          toolName: options.name,
          capability: options.capabilityKey,
          secretRef,
          credentialToken: options.credentialFor(context),
        },
        (secret) => options.run(args, secret, context),
        context.signal,
      );
    },
  };
}
