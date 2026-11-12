import { REDACTED, scrubString } from "@ago/shared";

/**
 * Every spelling of a value that is likely to survive a round trip through a tool: raw, base64 (padded and
 * not), base64url, hex (both cases), URL-encoded and JSON-escaped. Longest first, so a longer form is removed
 * before a shorter one that it contains.
 */
export function secretForms(value: string): string[] {
  if (value.length === 0) return [];
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const hex = bytes.toString("hex");
  const forms = new Set<string>([
    value,
    base64,
    base64.replace(/=+$/, ""),
    bytes.toString("base64url"),
    hex,
    hex.toUpperCase(),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]);
  return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

/**
 * Returns a function that removes one secret from any text, then applies the shared pattern scrubber
 * (AGO-104) for everything else that looks like a credential. Plain string splitting, no regular expression,
 * so a value full of special characters cannot break the match.
 */
export function createSecretScrubber(value: string): (text: string) => string {
  const forms = secretForms(value);
  return (text) => scrubString(forms.reduce((out, form) => out.split(form).join(REDACTED), text));
}
