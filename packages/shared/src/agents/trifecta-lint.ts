/**
 * The trifecta lint (AGO-138). An agent that can read untrusted content (a web page can carry hidden
 * instructions), see private data and send data out of the workspace can be tricked into leaking that data.
 * Any two of the three are manageable; all three together are blocked when an agent is created.
 *
 * Free of runtime imports (no zod) so the client wizard can use it from `@ago/shared/trifecta-lint` without
 * pulling zod into the browser bundle (same reason as `agent-limits.ts`).
 *
 * The mapping is by capability key (the catalog is per workspace, but the keys are stable). It covers the 12
 * starter capabilities of AGO-125; `trifecta-lint.test.ts` fails when a starter capability is neither mapped
 * here nor deliberately listed as neutral, so a new capability forces a decision. A key that is not mapped has
 * no leg. The grant mode (automatic or approval) is ignored: a capability the agent holds counts, because an
 * approval can be clicked through. There is no override in this version: the security-admin approval path
 * from the ticket is a follow-up (docs/tickets/AGO-138.md, decision q2).
 */

export const TRIFECTA_LEGS = ["untrusted", "private", "outbound"] as const;
export type TrifectaLeg = (typeof TRIFECTA_LEGS)[number];

/** How each leg is described to the owner. */
const LEG_LABELS: Record<TrifectaLeg, string> = {
  untrusted: "read untrusted content",
  private: "see private data",
  outbound: "send data out of the workspace",
};

/** Capability key to the leg it provides, with the name shown to the owner. */
const LEG_CAPABILITIES: Record<TrifectaLeg, Record<string, string>> = {
  untrusted: { "web.search": "Search the web", "web.browse": "Browse the web" },
  private: { "vault.read_private": "Read own private notes", "vault.read": "Read shared notes" },
  outbound: {
    "message.send_outbound": "Send outbound messages",
    "integration.write": "Write to integrations",
  },
};

export type TrifectaLintResult =
  | { ok: true }
  | {
      ok: false;
      /** The capabilities behind each leg (all three are present). */
      legs: Record<TrifectaLeg, string[]>;
      /** Names the field ("Capabilities:") and says what to remove. Safe to show. */
      message: string;
    };

/** Checks a set of capability keys (granted by any mode). Pure; never throws. */
export function lintTrifecta(capabilityKeys: Iterable<string>): TrifectaLintResult {
  const held = new Set(capabilityKeys);
  const legs: Record<TrifectaLeg, string[]> = { untrusted: [], private: [], outbound: [] };
  for (const leg of TRIFECTA_LEGS) {
    for (const [key, name] of Object.entries(LEG_CAPABILITIES[leg])) {
      if (held.has(key)) legs[leg].push(name);
    }
  }
  if (TRIFECTA_LEGS.some((leg) => legs[leg].length === 0)) return { ok: true };

  const parts = TRIFECTA_LEGS.map((leg) => `${LEG_LABELS[leg]} (${legs[leg].join(", ")})`);
  return {
    ok: false,
    legs,
    message:
      `Capabilities: this combination is blocked. Together they let the agent ${parts[0] ?? ""}, ` +
      `${parts[1] ?? ""} and ${parts[2] ?? ""}, so a hidden instruction in untrusted content could make it leak private data. ` +
      "Remove at least one of these capabilities. Approval for this combination is not available yet.",
  };
}

/** Keys the lint maps to a leg (for tests and docs). */
export function trifectaMappedKeys(): string[] {
  return TRIFECTA_LEGS.flatMap((leg) => Object.keys(LEG_CAPABILITIES[leg]));
}
