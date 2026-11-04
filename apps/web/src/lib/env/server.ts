import "server-only";

import { parseEnv, serverEnvSchema, type ServerEnv } from "@ago/shared";

let cached: ServerEnv | undefined;

/**
 * Validated server environment. Server-only: importing this from a client component
 * fails the build. Throws `EnvValidationError` naming missing or invalid variables
 * (never their values).
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseEnv(serverEnvSchema, process.env);
  return cached;
}
