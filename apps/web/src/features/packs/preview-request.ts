import { CONFLICT_RULES, DEFAULT_CONFLICT_RULE } from "@ago/shared/pack-import-preview";
import { z } from "zod";

/**
 * Query of POST /api/agent-packs/import/preview and POST /api/agent-packs/import (AGO-193, AGO-194). The pack file
 * itself is the request body, so its size can be limited on the raw bytes before anything is parsed; only the
 * workspace and the name-conflict rule travel in the query. Strict: an unknown query parameter is a 400. The CLI
 * validates its `--workspace` flag with it too. The preview and the apply share this one schema, so a dry run with
 * a rule shows exactly what the apply with the same rule does.
 */
export const previewPackImportQuerySchema = z.strictObject({
  workspace_id: z.uuid(),
  conflict: z.enum(CONFLICT_RULES).default(DEFAULT_CONFLICT_RULE),
});
export type PreviewPackImportQuery = z.infer<typeof previewPackImportQuerySchema>;
export const applyPackImportQuerySchema = previewPackImportQuerySchema;
