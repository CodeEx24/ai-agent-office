/**
 * Canonical JSON (AGO-192): one exact text for one value, so the same pack always gives the same bytes and the
 * same checksum. Rules: object keys sorted by UTF-16 code unit order, no whitespace, array order kept (the pack
 * builder sorts arrays before calling this), strings written by `JSON.stringify`. `undefined` object members are
 * skipped like `JSON.stringify` does; anything JSON cannot hold (a function, a bigint, a non-finite number) throws.
 * Pure and client-safe: no `node:crypto`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: cannot serialize a ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const member = record[key];
    if (member === undefined) continue;
    members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${members.join(",")}}`;
}
