import type { z } from "zod";

/** Raw env source: `process.env` or an explicit object of `NEXT_PUBLIC_*` literals. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface EnvIssue {
  readonly name: string;
  readonly kind: "missing" | "invalid";
  readonly reason: string;
}

/**
 * Thrown when env validation fails. The message names every missing or invalid
 * variable and NEVER includes a value, so it is safe to log and surface.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(formatEnvIssues(issues));
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

export function formatEnvIssues(issues: readonly EnvIssue[]): string {
  const lines = issues.map((issue) =>
    issue.kind === "missing"
      ? `  - ${issue.name}: missing (${issue.reason})`
      : `  - ${issue.name}: invalid (${issue.reason})`,
  );
  return [
    "Invalid environment configuration. Fix the variables below (values are never printed):",
    ...lines,
    "See .env.example and docs/environments.md.",
  ].join("\n");
}

function isUnset(value: string | undefined): boolean {
  return value === undefined || value === "";
}

/**
 * Validate `source` against `schema`. Returns the parsed env or throws
 * `EnvValidationError`. Only variable names and Zod's value-free reasons are reported.
 */
export function parseEnv<T extends z.ZodType>(schema: T, source: EnvSource): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const issues: EnvIssue[] = result.error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.map(String).join(".") : "(env)";
    const kind = isUnset(source[name]) ? "missing" : "invalid";
    return { name, kind, reason: issue.message };
  });
  throw new EnvValidationError(issues);
}
