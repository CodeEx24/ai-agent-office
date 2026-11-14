// AGO-47: the one hash an approval is bound to. The worker computes it from the exact tool name and arguments;
// it never trusts a hash it was handed.
import { describe, expect, it } from "vitest";

import { approvalPayloadHash, canonicalJson } from "./payload-hash.js";

describe("canonicalJson", () => {
  it("sorts object keys at every depth, so key order never changes the text", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order, which is part of the value", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("leaves undefined members out and writes non-JSON values as null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(() => 1)).toBe("null");
  });
});

describe("approvalPayloadHash", () => {
  const input = { path: "/tmp/a", opts: { force: true, depth: 2 }, list: [1, 2, 3] };

  it("is a SHA-256 hex digest", () => {
    expect(approvalPayloadHash("write_file", input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same hash when only the key order changes", () => {
    const reordered = { list: [1, 2, 3], opts: { depth: 2, force: true }, path: "/tmp/a" };

    expect(approvalPayloadHash("write_file", reordered)).toBe(
      approvalPayloadHash("write_file", input),
    );
  });

  it.each([
    ["a top-level value", { ...input, path: "/tmp/b" }],
    ["a nested value", { ...input, opts: { force: false, depth: 2 } }],
    ["an array element", { ...input, list: [1, 2, 4] }],
    ["array order", { ...input, list: [3, 2, 1] }],
    ["an added key", { ...input, extra: 1 }],
    ["a removed key", { path: "/tmp/a", opts: { force: true, depth: 2 } }],
    ["a value's type", { ...input, path: 5 }],
  ])("gives a different hash when %s changes", (_label, changed) => {
    expect(approvalPayloadHash("write_file", changed)).not.toBe(
      approvalPayloadHash("write_file", input),
    );
  });

  it("gives a different hash when the tool name changes", () => {
    expect(approvalPayloadHash("delete_file", input)).not.toBe(
      approvalPayloadHash("write_file", input),
    );
  });

  it("cannot be forged by moving text between the tool name and the arguments", () => {
    expect(approvalPayloadHash("a", { b: 1 })).not.toBe(approvalPayloadHash("a", { b: "1" }));
    expect(approvalPayloadHash('a","input":{"b":1}', null)).not.toBe(
      approvalPayloadHash("a", { b: 1 }),
    );
  });
});
