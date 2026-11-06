import type { RateLimitRule } from "./types";

const MINUTE = 60_000;

/**
 * Sensitive surfaces and their budgets. The proxy applies the coarse per-IP / per-user rules to
 * every matching request (a real HTTP 429); the finer per-identity rules guard a single action
 * and return a friendly message instead.
 */
export const RATE_LIMIT_RULES = {
  /** Sign-in form submissions (send code, verify code, OAuth start): per IP. */
  signInIp: { name: "sign-in-ip", limit: 60, windowMs: MINUTE },
  /** Magic-link / OAuth return point: per IP. */
  authCallbackIp: { name: "auth-callback-ip", limit: 30, windowMs: MINUTE },
  /** Authenticated mutations under /app (onboarding, future agent and approval routes): per user. */
  appMutationUser: { name: "app-mutation-user", limit: 60, windowMs: MINUTE },
  /** Authenticated reads of workspace catalogs under /api (AGO-125 capabilities): per user. */
  apiReadUser: { name: "api-read-user", limit: 120, windowMs: MINUTE },
  /** Emailing a sign-in code to one address. */
  sendCodeEmail: { name: "send-code-email", limit: 5, windowMs: 10 * MINUTE },
  /** Guessing the 6-digit code for one address. */
  verifyCodeEmail: { name: "verify-code-email", limit: 8, windowMs: 10 * MINUTE },
  /** Creating a workspace as one user. */
  onboardingUser: { name: "onboarding-user", limit: 10, windowMs: 10 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitScope = "ip" | "user";

export interface RouteRateLimit {
  rule: RateLimitRule;
  /** Who is counted. A "user" rule falls back to the IP when there is no signed-in user. */
  scope: RateLimitScope;
}

/**
 * The proxy-level rule for a request, or undefined when the route is not rate limited here.
 * Only state-changing or credential-bearing requests are limited; page views are not.
 */
export function matchRouteRateLimit(method: string, pathname: string): RouteRateLimit | undefined {
  const verb = method.toUpperCase();
  if (pathname === "/auth/callback" && verb === "GET") {
    return { rule: RATE_LIMIT_RULES.authCallbackIp, scope: "ip" };
  }
  if (pathname === "/api/capabilities" && verb === "GET") {
    return { rule: RATE_LIMIT_RULES.apiReadUser, scope: "user" };
  }
  if (verb !== "POST") return undefined;
  if (pathname === "/sign-in") return { rule: RATE_LIMIT_RULES.signInIp, scope: "ip" };
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    return { rule: RATE_LIMIT_RULES.appMutationUser, scope: "user" };
  }
  return undefined;
}
