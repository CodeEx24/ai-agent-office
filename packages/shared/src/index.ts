export * from "./env/index.js";
export * from "./redaction/index.js";
export * from "./workspace/roles.js";
export * from "./policy/policy-schemas.js";
export * from "./policy/policy-engine.js";
export * from "./capabilities/capability-schemas.js";
export * from "./capabilities/starter-capabilities.js";
export * from "./skills/skill-schemas.js";
export * from "./context/context-schemas.js";
export * from "./agents/agent-schemas.js";
export * from "./agents/agent-template-schemas.js";
export * from "./seed/seed-ids.js";
export * from "./identity/credential-schemas.js";

/** Project name shared by every workspace package. Placeholder until AGO-61+ add real schemas. */
export const PROJECT_NAME = "Agent Office";

export function describeWorkspace(packageName: string): string {
  return `${packageName} (${PROJECT_NAME})`;
}

export type { Database, Json } from "./db/database.types.js";
export * from "./events/index.js";
export * from "./agents/run-limits.js";
export * from "./agents/trifecta-lint.js";
export * from "./credentials/broker-schemas.js";
