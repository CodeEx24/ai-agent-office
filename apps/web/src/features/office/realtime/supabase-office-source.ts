import { REALTIME_SUBSCRIBE_STATES, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";

import type {
  FetchEventsArgs,
  FetchRunEventsArgs,
  OfficeEventSource,
  SubscribeHandlers,
} from "./office-event-source";

const EVENT_COLUMNS = "id, workspace_id, run_id, seq, type, payload, created_at";

interface RawEventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly [key: string]: unknown;
}

function isRawEventRow(value: unknown): value is RawEventRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.workspace_id === "string" &&
    typeof row.run_id === "string"
  );
}

/** PostgREST quoted value: the instant contains `+` and `:`, which must not be read as filter syntax. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The Supabase adapter of `OfficeEventSource` (AGO-126).
 *
 * Pass the **user-scoped** browser client (anon key + the user's session). RLS (`run_events_select_viewer`,
 * AGO-107) is what keeps other workspaces' rows from being returned or pushed; every query and the Realtime
 * filter also name the `workspace_id`, as defence in depth, never as the only guard. Never pass a service-role
 * client: it would bypass RLS.
 *
 * `agent_id` is not a `run_events` column: it is joined from `runs` with a workspace-scoped read and cached.
 * A row whose run cannot be resolved is dropped here (the controller fills the resulting gap by `seq`).
 */
export function createSupabaseOfficeSource(client: SupabaseClient<Database>): OfficeEventSource {
  const agentByRun = new Map<string, string>();

  async function resolveAgents(workspaceId: string, runIds: readonly string[]): Promise<void> {
    const missing = [...new Set(runIds)].filter((id) => !agentByRun.has(id));
    if (missing.length === 0) return;
    const { data, error } = await client
      .from("runs")
      .select("id, agent_id")
      .eq("workspace_id", workspaceId)
      .in("id", missing);
    if (error) throw new Error(`office source: runs lookup failed (${error.code})`);
    for (const run of data) agentByRun.set(run.id, run.agent_id);
  }

  async function withAgents(workspaceId: string, rows: readonly unknown[]): Promise<unknown[]> {
    const raw = rows.filter(isRawEventRow);
    await resolveAgents(
      workspaceId,
      raw.filter((r) => r.workspace_id === workspaceId).map((r) => r.run_id),
    );
    const out: unknown[] = [];
    for (const row of raw) {
      const agentId = agentByRun.get(row.run_id);
      if (agentId !== undefined) out.push({ ...row, agent_id: agentId });
    }
    return out;
  }

  return {
    async fetchEvents({ workspaceId, since, after, limit }: FetchEventsArgs) {
      let query = client.from("run_events").select(EVENT_COLUMNS).eq("workspace_id", workspaceId);
      if (since !== null) query = query.gte("created_at", since);
      if (after !== null) {
        query = query.or(
          `created_at.gt.${quote(after.created_at)},and(created_at.eq.${quote(after.created_at)},id.gt.${after.id})`,
        );
      }
      const { data, error } = await query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`office source: catch-up failed (${error.code})`);
      return withAgents(workspaceId, data);
    },

    async fetchRunEvents({ workspaceId, runId, afterSeq, limit }: FetchRunEventsArgs) {
      const { data, error } = await client
        .from("run_events")
        .select(EVENT_COLUMNS)
        .eq("workspace_id", workspaceId)
        .eq("run_id", runId)
        .gt("seq", afterSeq)
        .order("seq", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`office source: gap fill failed (${error.code})`);
      return withAgents(workspaceId, data);
    },

    subscribe(workspaceId: string, handlers: SubscribeHandlers) {
      let open = true;
      const isOpen = (): boolean => open;
      // Rows are joined to their agent one at a time, so the order they arrived in is kept.
      let chain: Promise<void> = Promise.resolve();

      const channel = client
        .channel(`office-events:${workspaceId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "run_events",
            filter: `workspace_id=eq.${workspaceId}`,
          },
          (payload) => {
            chain = chain.then(async () => {
              if (!open) return;
              try {
                const [row] = await withAgents(workspaceId, [payload.new]);
                if (isOpen() && row !== undefined) handlers.onRow(row);
              } catch {
                // The agent lookup failed: the row is not delivered; the controller fills the gap by `seq`.
              }
            });
          },
        )
        .subscribe((status) => {
          if (!open) return;
          if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) handlers.onStatus("subscribed");
          else if (status === REALTIME_SUBSCRIBE_STATES.CLOSED) handlers.onStatus("closed");
          else handlers.onStatus("error"); // CHANNEL_ERROR, TIMED_OUT
        });

      return () => {
        open = false;
        void client.removeChannel(channel);
      };
    },
  };
}
