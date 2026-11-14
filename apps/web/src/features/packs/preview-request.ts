import { z } from "zod";

/**
 * Query of POST /api/agent-packs/import/preview (AGO-193). The pack file itself is the request body, so its size
 * can be limited on the raw bytes before anything is parsed; only the workspace travels in the query. Strict: an
 * unknown query parameter is a 400. The CLI validates its `--workspace` flag with it too.
 */
export const previewPackImportQuerySchema = z.strictObject({
  workspace_id: z.uuid(),
});
export type PreviewPackImportQuery = z.infer<typeof previewPackImportQuerySchema>;
