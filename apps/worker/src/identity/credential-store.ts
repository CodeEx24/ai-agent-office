import type pg from "pg";

/** One credential as the log stores it. The token itself is never here: only its hash. */
export interface StoredCredential {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly capabilities: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface NewCredentialRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly tokenHash: string;
  readonly capabilities: readonly string[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The seam to the issuance log (`public.agent_credentials`). The database enforces the same rules as the
 * issuer (15 minute ceiling, granted capabilities only, live run only), so a buggy caller is rejected there too.
 */
export interface CredentialStore {
  /** Capabilities the agent holds that the workspace catalog has enabled. */
  grantedCapabilities(ref: { workspaceId: string; agentId: string }): Promise<string[]>;
  /** Append one issuance row. Rejects when the database refuses it. */
  insert(record: NewCredentialRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<StoredCredential | null>;
  /** Revoke every live credential of a run. Returns how many were revoked. */
  revokeForRun(ref: { workspaceId: string; runId: string }): Promise<number>;
}

interface CredentialRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  run_id: string;
  capabilities: string[];
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** Postgres store. The caller owns the pool and closes it. */
export function createPgCredentialStore(pool: pg.Pool): CredentialStore {
  return {
    async grantedCapabilities({ workspaceId, agentId }) {
      const result = await pool.query<{ capability: string }>(
        `select ac.capability
           from public.agent_capabilities ac
           join public.capabilities c on c.workspace_id = ac.workspace_id and c.key = ac.capability
          where ac.workspace_id = $1 and ac.agent_id = $2 and c.enabled
          order by ac.capability`,
        [workspaceId, agentId],
      );
      return result.rows.map((row) => row.capability);
    },

    async insert(record) {
      await pool.query(
        `insert into public.agent_credentials
           (id, workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
         values ($1, $2, $3, $4, $5, $6::text[], $7, $8)`,
        [
          record.id,
          record.workspaceId,
          record.agentId,
          record.runId,
          record.tokenHash,
          [...record.capabilities],
          record.issuedAt,
          record.expiresAt,
        ],
      );
    },

    async findByTokenHash(tokenHash) {
      const result = await pool.query<CredentialRow>(
        `select id, workspace_id, agent_id, run_id, capabilities, expires_at, revoked_at
           from public.agent_credentials where token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        runId: row.run_id,
        capabilities: row.capabilities,
        expiresAt: toDate(row.expires_at),
        revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at),
      };
    },

    async revokeForRun({ workspaceId, runId }) {
      const result = await pool.query(
        `update public.agent_credentials set revoked_at = now()
          where workspace_id = $1 and run_id = $2 and revoked_at is null`,
        [workspaceId, runId],
      );
      return result.rowCount ?? 0;
    },
  };
}
