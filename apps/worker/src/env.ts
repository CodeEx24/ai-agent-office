import { parseEnv, workerEnvSchema, type EnvSource, type WorkerEnv } from "@ago/shared";

/**
 * Validate the worker environment. Call once at process start so a missing or invalid
 * variable fails fast with a message naming it (values are never printed).
 */
export function loadWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
