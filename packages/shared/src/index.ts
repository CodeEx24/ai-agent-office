export * from "./env/index.js";
export * from "./redaction/index.js";
export * from "./workspace/roles.js";
export * from "./policy/policy-schemas.js";
export * from "./seed/seed-ids.js";

/** Project name shared by every workspace package. Placeholder until AGO-61+ add real schemas. */
export const PROJECT_NAME = "Agent Office";

export function describeWorkspace(packageName: string): string {
  return `${packageName} (${PROJECT_NAME})`;
}

export type { Database, Json } from "./db/database.types.js";
