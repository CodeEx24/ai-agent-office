/**
 * Secret redaction shared by the worker logger (AGO-143) and error tracking (AGO-104).
 *
 * Pure and client-safe, with no imports: the browser Sentry setup uses it through the
 * `@ago/shared/redaction` subpath. It must not import `env/client-schema`, because that would ship
 * the env-variable schema and its denylist into the browser bundle, which the AGO-67/70 bundle
 * guards (rightly) refuse. `redact.test.ts` pins `isSecretKey` to `isSecretLikeEnvName` instead.
 */

export const REDACTED = "[redacted]";

/** Default recursion limit for log payloads. Telemetry events use `EVENT_MAX_DEPTH`. */
const MAX_DEPTH = 6;
/** Sentry events nest deeper (exception.values[].stacktrace.frames[].vars), so allow more. */
const EVENT_MAX_DEPTH = 24;

/** `scheme://user:password@host`: the credentials part is replaced, the host is kept. */
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi;

/** Whole PEM private key blocks (or from the header to the end of the text when truncated). */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g;

/** Any JWT (Supabase anon and service-role keys, access tokens, ...). */
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}/g;

/** `Authorization: Bearer <token>` / `Basic <b64>` values, wherever they appear in text. */
const AUTH_SCHEME_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * `name=value` / `name: value` / `"name":"value"` where the name looks like a credential
 * (apikey, access_token, client_secret, password, authorization, ...). Covers query strings,
 * headers dumped into a message and JSON fragments. Over-redaction is the safe failure.
 */
const CREDENTIAL_ASSIGNMENT =
  /\b([\w.-]{0,40}(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|credential)[\w.-]{0,40})(["']?\s*[:=]\s*["']?)(?!\[redacted\])([^\s"'&,;)}\]]+)/gi;

/**
 * Well-known secret value shapes, flagged whatever they are called. Also the canonical list for
 * `scripts/check-client-bundle.mjs` (one source of truth, AGO-104). Not global: used with `.test`.
 */
export const SECRET_VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/sk-proj-[A-Za-z0-9_-]{20,}/, "OpenAI project key"],
  [/\bsk-[A-Za-z0-9]{48,}\b/, "OpenAI API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{22,}/, "GitHub fine-grained token"],
  [/\bsbp_[0-9a-f]{40}\b/, "Supabase access token"],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}/, "Supabase secret key"],
  [/\b(sk|rk)_live_[0-9a-zA-Z]{24,}/, "Stripe live key"],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}/, "Slack token"],
  [/\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/, "Telegram bot token"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "private key"],
];

const GLOBAL_SECRET_VALUE_PATTERNS = SECRET_VALUE_PATTERNS.map(
  ([pattern]) => new RegExp(pattern.source, `${pattern.flags}g`),
);

/**
 * Same rule as `isSecretLikeEnvName` (deny by default): a name is secret when it contains a secret
 * fragment, has a secret `_`-separated token, or ends with KEY. Written here, not imported, so the
 * browser bundle stays free of the env schema (see the module comment).
 */
const SECRET_FRAGMENTS = [
  "apikey",
  "secret",
  "token",
  "password",
  "passwd",
  "private",
  "credential",
  "auth",
  "signing",
];
const SECRET_TOKENS = ["key", "pwd"];

/** Keys that hold credentials but are not env-style names (`isSecretLikeEnvName` misses them). */
const SENSITIVE_KEY_EXTRAS = new Set([
  "cookie",
  "cookies",
  "set_cookie",
  "session",
  "sessionid",
  "session_id",
  "sid",
]);

/** Mask secret shapes and credentials inside any string, including free-text messages. */
export function scrubString(value: string): string {
  let out = value.replace(PRIVATE_KEY_BLOCK, REDACTED);
  out = out.replace(CREDENTIAL_URL, `$1${REDACTED}@`);
  out = out.replace(JWT, REDACTED);
  for (const pattern of GLOBAL_SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(AUTH_SCHEME_VALUE, `$1 ${REDACTED}`);
  out = out.replace(CREDENTIAL_ASSIGNMENT, `$1$2${REDACTED}`);
  return out;
}

/** True for object keys whose value must never be recorded (camelCase and kebab-case aware). */
export function isSecretKey(key: string): boolean {
  const snake = key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  return (
    SECRET_FRAGMENTS.some((fragment) => snake.includes(fragment)) ||
    snake.endsWith("key") ||
    snake.split("_").some((token) => SECRET_TOKENS.includes(token)) ||
    SENSITIVE_KEY_EXTRAS.has(snake)
  );
}

function scrubInner(
  value: unknown,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth || seen.has(value)) return REDACTED;
  seen.add(value);
  try {
    if (value instanceof Error) {
      return {
        type: value.name,
        message: scrubString(value.message),
        stack: value.stack === undefined ? undefined : scrubString(value.stack),
      };
    }
    if (Array.isArray(value)) {
      return value.map((item) => scrubInner(item, depth + 1, maxDepth, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? REDACTED : scrubInner(inner, depth + 1, maxDepth, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Deep-copy a payload, masking secret-named keys and secret shapes in strings. Never mutates. */
export function scrubValue(value: unknown, depth = 0): unknown {
  return scrubInner(value, depth, MAX_DEPTH, new WeakSet());
}

/**
 * Scrub a whole telemetry event (a Sentry error event or breadcrumb): message, exception values,
 * extra, contexts, request, tags and breadcrumbs. Works structurally, so it has no Sentry import.
 * Visitor data other than an id is dropped from `user`.
 */
export function scrubTelemetryEvent<T extends object>(event: T): T {
  const scrubbed = scrubInner(event, 0, EVENT_MAX_DEPTH, new WeakSet()) as Record<string, unknown>;
  const user = scrubbed.user;
  if (typeof user === "object" && user !== null) {
    const id = (user as Record<string, unknown>).id;
    scrubbed.user = id === undefined ? {} : { id };
  }
  return scrubbed as T;
}
