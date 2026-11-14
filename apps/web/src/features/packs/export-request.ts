import { z } from "zod";

/** Most agents one pack can hold (MAX_PACK_AGENTS in packages/shared). */
const MAX_EXPORT_AGENTS = 100;

/**
 * Body of POST /api/agent-packs/export. `agent_ids` omitted means every active agent of the workspace;
 * a list means exactly those agents (archived ones too, when named). Strict: an unknown field is a 400.
 */
export const exportAgentPackRequestSchema = z.strictObject({
  workspace_id: z.uuid(),
  agent_ids: z.array(z.uuid()).min(1).max(MAX_EXPORT_AGENTS).optional(),
  name: z.string().trim().min(1).max(120).optional(),
});
export type ExportAgentPackRequest = z.infer<typeof exportAgentPackRequestSchema>;
