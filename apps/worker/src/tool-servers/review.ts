import { hasAgentCredential, secretRefSchema, toolServerIdSchema } from "@ago/shared";

import { hashSnapshot } from "./canonical-hash.js";
import { fetchSnapshot } from "./client.js";
import { diffSnapshots } from "./snapshot-diff.js";

import type { ToolServerConnector } from "./client.js";
import type { ToolServerRegistry } from "./registry.js";
import type { ToolServerDiffSummary, ToolServerSnapshot } from "@ago/shared";

/**
 * Human review of a tool server (AGO-68): allowlist it, look at its tool list, pin the exact hash that was
 * reviewed. Only a person does this; agents never approve a changed tool, change their own rules or bypass
 * policy. The first pin is a review too: nothing is trusted on first use.
 *
 * These functions are the only writers of the registry. The web route and UI that call them are a follow-up;
 * that route must be a human-only route (session, not an agent credential), and every function here checks the
 * actor again so a misrouted call still fails.
 */
export interface HumanActor {
  readonly kind: "human";
  readonly userId: string;
  /** The request's headers when there are any: an agent credential among them is refused. */
  readonly headers?: { get(name: string): string | null };
}

export type ReviewFailure =
  | "human_only"
  | "invalid_input"
  | "not_allowlisted"
  | "snapshot_unavailable"
  | "snapshot_changed"
  | "identity_mismatch";

export class ReviewError extends Error {
  readonly reason: ReviewFailure;
  constructor(reason: ReviewFailure) {
    super(`tool server review refused (${reason})`);
    this.name = "ReviewError";
    this.reason = reason;
  }
}

export function assertHuman(actor: unknown): asserts actor is HumanActor {
  const candidate = actor as Partial<HumanActor> | null | undefined;
  if (
    typeof candidate !== "object" ||
    candidate?.kind !== "human" ||
    typeof candidate.userId !== "string" ||
    candidate.userId === ""
  ) {
    throw new ReviewError("human_only");
  }
  if (candidate.headers !== undefined && hasAgentCredential(candidate.headers)) {
    throw new ReviewError("human_only");
  }
}

export interface ReviewDeps {
  readonly registry: ToolServerRegistry;
  readonly connector: ToolServerConnector;
  readonly now?: () => Date;
}

export interface AllowlistRequest {
  readonly workspaceId: string;
  readonly serverId: string;
  /** The audience credentials for this server are bound to. */
  readonly audience: string;
  /** `secret:<name>`: the broker's key for minting audience-bound tokens for this server. */
  readonly audienceSecretRef: string;
}

/** Allowlist a server. It stays blocked (`pin_missing`) until a person reviews and pins it. */
export async function allowlistServer(
  deps: ReviewDeps,
  actor: unknown,
  request: AllowlistRequest,
): Promise<void> {
  assertHuman(actor);
  if (
    !toolServerIdSchema.safeParse(request.serverId).success ||
    request.audience === "" ||
    !secretRefSchema.safeParse(request.audienceSecretRef).success
  ) {
    throw new ReviewError("invalid_input");
  }
  await deps.registry.allowlist({
    workspaceId: request.workspaceId,
    serverId: request.serverId,
    audience: request.audience,
    audienceSecretRef: request.audienceSecretRef,
    allowlistedBy: actor.userId,
    allowlistedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
}

export interface ReviewSnapshot {
  /** The hash a person approves. `reviewAndPin` pins only this exact hash. */
  readonly hash: string;
  readonly snapshot: ToolServerSnapshot;
  /** Against the current pin; null when nothing is pinned yet (a first review). */
  readonly diff: ToolServerDiffSummary | null;
}

async function liveSnapshot(deps: ReviewDeps, workspaceId: string, serverId: string) {
  const entry = await deps.registry.get(workspaceId, serverId);
  if (entry === null) throw new ReviewError("not_allowlisted");
  let snapshot: ToolServerSnapshot;
  let hash: string;
  try {
    snapshot = await fetchSnapshot(deps.connector, workspaceId, serverId);
    hash = hashSnapshot(snapshot);
  } catch {
    throw new ReviewError("snapshot_unavailable");
  }
  if (snapshot.serverId !== serverId) throw new ReviewError("identity_mismatch");
  return { entry, snapshot, hash };
}

/** What a person looks at: the live tool list, its hash and what changed against the pin. */
export async function prepareReview(
  deps: ReviewDeps,
  actor: unknown,
  scope: { readonly workspaceId: string; readonly serverId: string },
): Promise<ReviewSnapshot> {
  assertHuman(actor);
  const { entry, snapshot, hash } = await liveSnapshot(deps, scope.workspaceId, scope.serverId);
  let diff: ToolServerDiffSummary | null = null;
  if (entry.pin !== null) {
    try {
      diff = diffSnapshots(entry.pin.snapshot, snapshot);
    } catch {
      throw new ReviewError("snapshot_unavailable");
    }
  }
  return { hash, snapshot, diff };
}

/**
 * Pin the snapshot a person reviewed. The approval is bound to `reviewedHash`: the server's tool list is read
 * again now and must still hash to it. A server that changed between the review and this call stays blocked
 * (`snapshot_changed`) and needs a new review.
 */
export async function reviewAndPin(
  deps: ReviewDeps,
  actor: unknown,
  request: {
    readonly workspaceId: string;
    readonly serverId: string;
    readonly reviewedHash: string;
  },
): Promise<{ readonly hash: string }> {
  assertHuman(actor);
  const { snapshot, hash } = await liveSnapshot(deps, request.workspaceId, request.serverId);
  if (hash !== request.reviewedHash) throw new ReviewError("snapshot_changed");
  const pinned = await deps.registry.pin(request.workspaceId, request.serverId, {
    hash,
    snapshot,
    pinnedBy: actor.userId,
    pinnedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  if (!pinned) throw new ReviewError("not_allowlisted");
  return { hash };
}
