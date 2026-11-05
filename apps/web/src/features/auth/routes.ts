import { safeNextPath } from "./safe-next-path";

export const SIGN_IN_PATH = "/sign-in";

/** Route prefixes that need a signed-in user. Everything else is public. */
const PROTECTED_PREFIXES = ["/app"] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Sign-in URL path that brings the user back to `target` afterwards. */
export function signInPathFor(target: string): string {
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(safeNextPath(target))}`;
}
