/**
 * The port between the realtime controller and the database (AGO-126).
 *
 * The controller never touches Supabase directly: it talks to an `OfficeEventSource`, so the ordering,
 * overlap, gap and reconnect logic is tested with a fake, and the Supabase adapter stays thin.
 *
 * Every row a source returns or pushes is `unknown` on purpose: it is validated (`officeEventRecordSchema`
 * and the reducer) on the way in, never trusted. Rows already carry `agent_id` (the adapter joins `runs`).
 */

/** A position in the workspace feed, `(created_at, id)`. */
export interface FeedPosition {
  readonly created_at: string;
  readonly id: string;
}

export interface FetchEventsArgs {
  readonly workspaceId: string;
  /** Include rows with `created_at >= since` (ISO instant). Null: from the start of the feed. */
  readonly since: string | null;
  /** Keyset paging: only rows strictly after this position, in feed order. */
  readonly after: FeedPosition | null;
  readonly limit: number;
}

export interface FetchRunEventsArgs {
  readonly workspaceId: string;
  readonly runId: string;
  /** Rows with `seq > afterSeq`, ascending. */
  readonly afterSeq: number;
  readonly limit: number;
}

/** Channel health as the controller sees it. */
export type SubscriptionStatus = "subscribed" | "closed" | "error";

export interface SubscribeHandlers {
  /** A new row, already joined to its run's `agent_id`. Delivered in the order rows were inserted. */
  readonly onRow: (row: unknown) => void;
  readonly onStatus: (status: SubscriptionStatus) => void;
}

export interface OfficeEventSource {
  /** Rows in feed order `(created_at, id)`, at most `limit`. Rejects on a transport error. */
  fetchEvents(args: FetchEventsArgs): Promise<readonly unknown[]>;
  /** One run's rows after a sequence number, ascending by `seq`. Fills a gap exactly. */
  fetchRunEvents(args: FetchRunEventsArgs): Promise<readonly unknown[]>;
  /** Start a stream for one workspace. Returns the function that tears it down. */
  subscribe(workspaceId: string, handlers: SubscribeHandlers): () => void;
}

export type OfficeRealtimeStatus =
  "idle" | "connecting" | "live" | "catching_up" | "reconnecting" | "stopped";
