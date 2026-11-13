import { z } from "zod";

import { agentPackSchema, PACK_VERSION } from "./agent-pack-schemas.js";

/** Where the committed JSON Schema lives, relative to `packages/shared`. */
export const AGENT_PACK_JSON_SCHEMA_PATH = `schemas/agent-pack.v${String(PACK_VERSION)}.schema.json`;

/**
 * The JSON Schema of the pack, generated from the Zod schema so the two cannot drift. Editors use the
 * committed file to validate packs. Cross-field rules (unique names, skills that exist, no secret-shaped
 * values) are not expressible in JSON Schema; the Zod schema stays the authority.
 */
export function buildAgentPackJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(agentPackSchema, { target: "draft-2020-12", io: "input" });
  return {
    ...schema,
    $id: `https://agent-office.dev/schemas/agent-pack.v${String(PACK_VERSION)}.schema.json`,
    title: "Agent Office agent pack",
    description:
      "A portable team of agents and skills. Never contains secrets, ids or run history; credentials appear only as secret:<name> references.",
  };
}

/** The exact text of the committed file. */
export function renderAgentPackJsonSchema(): string {
  return `${JSON.stringify(buildAgentPackJsonSchema(), null, 2)}\n`;
}
