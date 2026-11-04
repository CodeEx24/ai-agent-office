export * from "./env/index.js";

/** Project name shared by every workspace package. Placeholder until AGO-61+ add real schemas. */
export const PROJECT_NAME = "Agent Office";

export function describeWorkspace(packageName: string): string {
  return `${packageName} (${PROJECT_NAME})`;
}

export type { Database, Json } from "./db/database.types.js";
