import { z } from "zod";

/**
 * The consequence summary and the payload view of an approval card (AGO-54). Pure and deterministic: no I/O, no
 * clock, no randomness, so the same stored fields always give the same words, and it is tested without a database.
 *
 * It is built on the server (in `buildApprovalCards`) from STORED, structured fields only: the tool name, the tier
 * and, once AGO-215 stores it, the call's structured arguments. It never reads agent prose (a message, a summary, a
 * step label). Every string is plain text for React to render as text; nothing here is HTML.
 */

/** Longest value, in characters, kept for one argument line. Longer values are cut and the view says so. */
export const MAX_PAYLOAD_VALUE_CHARS = 2_000;
/** Most argument lines a card shows. */
export const MAX_PAYLOAD_LINES = 40;

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * The structured arguments of one approved-for call, as the approvals table will store them (AGO-215). Strict about
 * shape: a record of JSON values. Anything else is not a payload and the card treats it as unavailable.
 */
export const storedApprovalPayloadSchema = z.record(z.string().min(1).max(200), jsonValueSchema);

/**
 * Where a card's call details come from. Today nothing stores them, so the only value anything produces is
 * `unavailable`. AGO-215 stores the payload and fills `stored` in `inbox-data.ts`; the hardening listed in docs/tickets/AGO-54.md must land with it.
 */
export type ApprovalPayloadSource =
  | { readonly kind: "unavailable" }
  | { readonly kind: "stored"; readonly args: Readonly<Record<string, JsonValue>> };

export interface PayloadLine {
  readonly key: string;
  readonly value: string;
}

/** What the bounded payload region of a card shows. */
export type ApprovalPayloadView =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "stored";
      readonly lines: readonly PayloadLine[];
      /** True when lines or values were cut to the limits above, so the view is not the whole call. */
      readonly isTruncated: boolean;
    };

export type ConsequenceSeverity = "elevated" | "critical";

export interface ConsequenceSummary {
  /** One sentence: what will happen if this is approved. Always shown first on the card. */
  readonly headline: string;
  /** Short supporting lines, each built from a structured field (never free text). */
  readonly details: readonly string[];
  /** The risk tier in words, e.g. "Tier 3: always needs a person". */
  readonly tierLabel: string;
  readonly severity: ConsequenceSeverity;
}

/** What each known tool does, as a verb phrase after "the agent". Looked up by exact tool name only. */
const TOOL_EFFECTS: ReadonlyMap<string, string> = new Map([
  ["email.send", "send an email on your behalf"],
  ["calendar.invite", "send a calendar invitation on your behalf"],
  ["code.run", "run code in the sandbox"],
  ["vault.write_shared", "change a note in the shared vault"],
  ["vault.write_owner", "change a note in the owner's vault area"],
  ["vault.write", "change a note in the vault"],
  ["vault.delete", "delete a note from the vault"],
  ["vault.read_private", "read a private note in the vault"],
  ["file.delete", "delete a file"],
  ["web.fetch_write", "send data to a website"],
  ["browser.navigate", "open a page in a browser"],
]);

function tierLabel(tier: number | null): string {
  if (tier === null) return "Tier unknown: treated as needing a person";
  if (tier >= 4) return "Tier 4: highest risk, always needs a person";
  if (tier === 3) return "Tier 3: always needs a person";
  return `Tier ${String(tier)}: a policy asked for a person`;
}

/** Keys of the structured arguments, named in the details so the owner knows which fields the call carries. */
function argumentNames(args: Readonly<Record<string, JsonValue>>): string {
  const names = Object.keys(args);
  const shown = names.slice(0, 8).join(", ");
  return names.length > 8 ? `${shown}, and ${String(names.length - 8)} more` : shown;
}

/**
 * What approving this card will do. `tool` is the stored tool name and `tier` the stored tier (null when the run
 * events were not read). With the stored payload the details name its fields; without it they say plainly that the
 * call's details are not stored. The headline is built from the tool table or, for a tool it does not know, a generic
 * sentence that names the tool and promises nothing about its effect.
 */
export function summarizeConsequence(
  tool: string,
  tier: number | null,
  payload: ApprovalPayloadSource,
): ConsequenceSummary {
  const effect = TOOL_EFFECTS.get(tool);
  const headline =
    effect === undefined
      ? `Approving lets the agent run “${tool}”. What it will change depends on the call's details.`
      : `Approving lets the agent ${effect}.`;

  const details: string[] = [];
  if (payload.kind === "stored") {
    const names = argumentNames(payload.args);
    details.push(names === "" ? "The call carries no arguments." : `The call carries: ${names}.`);
  } else {
    details.push(
      "The exact call (for example the recipient or the content) is not stored, so it cannot be shown.",
    );
  }
  details.push("It runs exactly the call the agent asked for, once, and only if you approve.");

  return {
    headline,
    details,
    tierLabel: tierLabel(tier),
    severity: tier !== null && tier >= 4 ? "critical" : "elevated",
  };
}

function stringify(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Cut to the character limit, dropping a high surrogate left alone at the end so an emoji is never split. */
function cutWithoutSplittingPair(text: string): string {
  const cut = text.slice(0, MAX_PAYLOAD_VALUE_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The payload region's content: one line per argument, in the stored order, every value as text and cut to the
 * limits. A source that does not match the schema is treated as unavailable, never shown.
 */
export function buildPayloadView(source: ApprovalPayloadSource): ApprovalPayloadView {
  if (source.kind !== "stored") return { kind: "unavailable" };
  const parsed = storedApprovalPayloadSchema.safeParse(source.args);
  if (!parsed.success) return { kind: "unavailable" };

  const entries = Object.entries(parsed.data);
  let isTruncated = entries.length > MAX_PAYLOAD_LINES;
  const lines = entries.slice(0, MAX_PAYLOAD_LINES).map(([key, value]) => {
    const text = stringify(value);
    if (text.length <= MAX_PAYLOAD_VALUE_CHARS) return { key, value: text };
    isTruncated = true;
    return { key, value: cutWithoutSplittingPair(text) };
  });
  return { kind: "stored", lines, isTruncated };
}
