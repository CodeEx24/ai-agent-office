import { describe, expect, it } from "vitest";
import { z } from "zod";

import { authCallbackQuerySchema, signInQuerySchema } from "../../features/auth/schemas";
import {
  formDataToRecord,
  invalidInputResponse,
  parseInput,
  searchParamsToRecord,
} from "./parse-input";

describe("parseInput", () => {
  const schema = z.object({ name: z.string().min(1, "Name is required.") });

  it("returns typed data on success", () => {
    expect(parseInput(schema, { name: "Ada" })).toEqual({ success: true, data: { name: "Ada" } });
  });

  it("returns the first issue message on failure", () => {
    const result = parseInput(schema, { name: "" });

    expect(result).toMatchObject({ success: false, message: "Name is required." });
  });

  it("rejects non-object input instead of throwing", () => {
    expect(parseInput(schema, null).success).toBe(false);
    expect(parseInput(schema, "x").success).toBe(false);
    expect(parseInput(schema, undefined).success).toBe(false);
  });
});

describe("input record helpers", () => {
  it("formDataToRecord keeps strings and drops files", () => {
    const form = new FormData();
    form.set("a", "1");
    form.set("file", new Blob(["x"]), "x.txt");

    expect(formDataToRecord(form)).toEqual({ a: "1" });
  });

  it("searchParamsToRecord keeps the first value and cannot pollute the prototype", () => {
    const record = searchParamsToRecord(
      new URLSearchParams("a=1&a=2&__proto__=evil&constructor=x"),
    );

    expect(record.a).toBe("1");
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it("invalidInputResponse is a 400 JSON body", async () => {
    const response = invalidInputResponse("bad");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_input", message: "bad" });
  });
});

describe("route query schemas", () => {
  it("authCallbackQuerySchema accepts the expected shape and rejects oversized values", () => {
    expect(parseInput(authCallbackQuerySchema, { code: "abc", next: "/app" }).success).toBe(true);
    expect(parseInput(authCallbackQuerySchema, {}).success).toBe(true);
    expect(parseInput(authCallbackQuerySchema, { code: "x".repeat(3000) }).success).toBe(false);
    expect(parseInput(authCallbackQuerySchema, { code: "" }).success).toBe(false);
  });

  it("signInQuerySchema collapses repeated parameters and bounds length", () => {
    const result = parseInput(signInQuerySchema, { next: ["/app", "//evil"], error: "callback" });

    expect(result).toEqual({ success: true, data: { next: "/app", error: "callback" } });
    expect(parseInput(signInQuerySchema, { error: "e".repeat(65) }).success).toBe(false);
  });
});
