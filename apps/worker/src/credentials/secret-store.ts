import { secretRefSchema } from "@ago/shared";

/** What a tool asked for. The store answers only when all three match. */
export interface SecretLookup {
  readonly workspaceId: string;
  /** The reference's name part (`crm_api_key` for `secret:crm_api_key`). */
  readonly name: string;
  /** The capability the call needs. A secret is usable only for the capabilities it was bound to. */
  readonly capability: string;
}

/**
 * The seam to wherever secret values live (AGO-157). Server only: nothing outside the broker calls it, and the
 * value it returns is handed to a tool's function inside the broker and never returned past it.
 *
 * `null` means "not available to this caller" for any reason (unknown name, another workspace, a capability the
 * secret is not bound to). The reasons are deliberately not told apart, so a caller cannot probe for names.
 */
export interface SecretStore {
  resolve(lookup: SecretLookup): Promise<string | null>;
}

export interface SecretEntry {
  readonly workspaceId: string;
  readonly name: string;
  readonly value: string;
  /** The capabilities this secret may serve. Empty means it serves none. */
  readonly capabilities: readonly string[];
}

/**
 * In-memory store: for tests and for whoever wires the first secret-using tool. The database-backed vault
 * (encryption at rest, a UI) is AGO-185 and plugs in behind the same interface.
 */
export function createInMemorySecretStore(entries: readonly SecretEntry[]): SecretStore {
  const byKey = new Map<string, SecretEntry>();
  for (const entry of entries) {
    // Throws on a bad name or an empty value; the message never contains the value.
    secretRefSchema.parse(`secret:${entry.name}`);
    if (entry.value.length === 0) throw new Error(`secret "${entry.name}" has an empty value`);
    byKey.set(`${entry.workspaceId}\u0000${entry.name}`, entry);
  }
  return {
    resolve({ workspaceId, name, capability }) {
      const entry = byKey.get(`${workspaceId}\u0000${name}`);
      return Promise.resolve(
        entry?.capabilities.includes(capability) === true ? entry.value : null,
      );
    },
  };
}
