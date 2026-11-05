/**
 * Entry point for client components: `import { ... } from "@ago/shared/client-env"`.
 * Deliberately excludes the server schema so no server-only variable name is bundled.
 */
export { CLIENT_ENV_NAMES, clientEnvSchema, type ClientEnv } from "./client-schema.js";
export { EnvValidationError, parseEnv, type EnvSource } from "./parse.js";
