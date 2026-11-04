import { z } from "zod";

export const DEFAULT_SIGNED_IN_PATH = "/app";

// Placeholder origin used only to prove a value stays on our own origin once resolved.
const PROBE_ORIGIN = "http://ago.invalid";

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * A same-origin, path-only redirect target. Rejects anything a browser could read as another
 * origin: absolute URLs, protocol-relative `//host`, backslash tricks (`/\host`), control
 * characters, and encoded variants of those.
 */
const safeNextPathSchema = z
  .string()
  .max(2048)
  .refine((value) => value.startsWith("/") && !value.startsWith("//"), "must be a local path")
  .refine((value) => !value.includes("\\"), "must not contain backslashes")
  .refine((value) => !hasControlCharacter(value), "must not contain control characters")
  .refine((value) => {
    try {
      // Browsers treat `%2F`/`%5C` after the first slash as path data, but decode once to be
      // strict: a decoded `//` or `\` would be a host in disguise if something decodes twice.
      const decoded = decodeURIComponent(value);
      if (decoded.startsWith("//") || decoded.includes("\\")) return false;
      return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN;
    } catch {
      return false;
    }
  }, "must resolve to the same origin");

/** Returns `next` when it is a safe local path, otherwise the default landing page. */
export function safeNextPath(
  next: string | string[] | null | undefined,
  fallback: string = DEFAULT_SIGNED_IN_PATH,
): string {
  const candidate = Array.isArray(next) ? next[0] : next;
  const parsed = safeNextPathSchema.safeParse(candidate);
  return parsed.success ? parsed.data : fallback;
}
