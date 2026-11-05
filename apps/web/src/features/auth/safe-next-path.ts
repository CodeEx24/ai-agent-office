import { getAppUrl } from "../../lib/env";

export const DEFAULT_SIGNED_IN_PATH = "/app";

/** Only these route prefixes (whole path segments) may be a post-sign-in destination. */
const ALLOWED_PREFIXES = ["/app", "/approvals"] as const;

const MAX_LENGTH = 2048;
// Encoded slash or backslash: never legitimate in a redirect target, and the usual way to smuggle
// `//host` past a check that only looks at the raw string.
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAllowedPath(pathname: string): boolean {
  return ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isSinglePathSyntax(value: string): boolean {
  if (value.length > MAX_LENGTH || !value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || hasControlCharacter(value) || ENCODED_SEPARATOR.test(value)) {
    return false;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value); // decode exactly once
  } catch {
    return false;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return false;
  if (decoded.includes("\\") || hasControlCharacter(decoded)) return false;
  const pathOnly = decoded.split(/[?#]/, 1)[0] ?? "";
  return !pathOnly.split("/").includes("..");
}

/**
 * Validates a post-sign-in redirect target and returns a normalized same-origin path
 * (`/path?query#hash`), or `fallback`. It must be a single-leading-slash path with no `..`
 * segments, backslashes, control characters or encoded separators; it is then resolved against
 * the configured app origin, which must be unchanged, and the path must be on the allowlist.
 */
export function safeNextPath(
  next: string | string[] | null | undefined,
  fallback: string = DEFAULT_SIGNED_IN_PATH,
): string {
  const candidate = Array.isArray(next) ? next[0] : next;
  if (typeof candidate !== "string" || !isSinglePathSyntax(candidate)) return fallback;

  try {
    const base = new URL(getAppUrl());
    const resolved = new URL(candidate, base);
    if (resolved.origin !== base.origin || !isAllowedPath(resolved.pathname)) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}
