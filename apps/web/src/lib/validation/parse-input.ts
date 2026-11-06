import type { z } from "zod";

export type ParsedInput<T> =
  { success: true; data: T } | { success: false; message: string; issues: z.core.$ZodIssue[] };

/**
 * The single entry point for validating untrusted input (form data, query strings, request
 * bodies, route params) at a server boundary. Every route handler, server action and page that
 * reads input calls this (or documents `@no-input`); `input-validation.test.ts` enforces it.
 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
  fallbackMessage = "Invalid input.",
): ParsedInput<z.output<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    message: result.error.issues[0]?.message ?? fallbackMessage,
    issues: result.error.issues,
  };
}

/** String entries of a FormData as a plain object. Files are dropped; the last duplicate wins. */
export function formDataToRecord(formData: FormData): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

/** First value of each query parameter as a plain object with no prototype (no `__proto__` keys). */
export function searchParamsToRecord(searchParams: URLSearchParams): Record<string, string> {
  const record = Object.create(null) as Record<string, string>;
  for (const [key, value] of searchParams.entries()) {
    if (!(key in record)) record[key] = value;
  }
  return record;
}

/** 400 body for a route handler whose input failed validation. */
export function invalidInputResponse(message: string): Response {
  return Response.json({ error: "invalid_input", message }, { status: 400 });
}
