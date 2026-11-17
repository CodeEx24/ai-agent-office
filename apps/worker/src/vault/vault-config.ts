import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { EnvSource } from "@ago/shared";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const vaultEnvSchema = z.object({
  /** Folder that holds one git repo per workspace (`<root>/<workspace_id>`). Never inside a repo checkout in production. */
  VAULT_ROOT_DIR: z.preprocess(emptyToUndefined, z.string().min(1).default(".vault-data")),
  /** Starter layout copied into every new vault. Defaults to `vault-template/` at the repo root. */
  VAULT_TEMPLATE_DIR: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});

export interface VaultConfig {
  readonly rootDir: string;
  readonly templateDir: string;
}

/** `apps/worker/{src,dist}/vault` sits four levels under the repo root in both layouts. */
export function defaultVaultTemplateDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", "vault-template");
}

export function loadVaultConfig(env: EnvSource, cwd: string = process.cwd()): VaultConfig {
  const parsed = vaultEnvSchema.parse(env);
  return {
    rootDir: path.resolve(cwd, parsed.VAULT_ROOT_DIR),
    templateDir: path.resolve(cwd, parsed.VAULT_TEMPLATE_DIR ?? defaultVaultTemplateDir()),
  };
}
