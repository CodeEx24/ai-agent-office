import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  AGENT_CREDENTIAL_PREFIX,
  agentCredentialClaimsSchema,
  type AgentCredentialClaims,
} from "@ago/shared";

/**
 * Agent credential tokens (AGO-148): `ago_agt_<header>.<payload>.<signature>`, an HS256 JWT-shaped value with a
 * fixed prefix so a guard can tell it from a human session without any crypto. Uses `node:crypto` only (no new
 * dependency). The header is fixed and never read back: `alg` cannot be downgraded because there is nothing to
 * choose. The signing secret is server-only (AGO-70 env schema).
 *
 * A token is never stored or logged; only `hashCredentialToken(token)` goes to the database.
 */

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const MIN_SECRET_LENGTH = 32;

export type TokenCheck =
  | { readonly ok: true; readonly claims: AgentCredentialClaims }
  | { readonly ok: false; readonly reason: "malformed" | "bad_signature" };

function sign(signingInput: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

function assertUsableSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `the credential signing secret must be at least ${String(MIN_SECRET_LENGTH)} characters`,
    );
  }
}

/** Sign claims. Throws on invalid claims (for example a lifetime over 15 minutes): never signs them. */
export function signCredentialToken(claims: AgentCredentialClaims, secret: string): string {
  assertUsableSecret(secret);
  const valid = agentCredentialClaimsSchema.parse(claims);
  const payload = Buffer.from(JSON.stringify(valid)).toString("base64url");
  const signingInput = `${HEADER}.${payload}`;
  return `${AGENT_CREDENTIAL_PREFIX}${signingInput}.${sign(signingInput, secret).toString("base64url")}`;
}

/**
 * Check shape and signature, then parse the claims. Does not look at expiry or the database: the verifier
 * does. The signature is compared in constant time.
 */
export function verifyCredentialToken(token: string, secret: string): TokenCheck {
  assertUsableSecret(secret);
  if (!token.startsWith(AGENT_CREDENTIAL_PREFIX)) return { ok: false, reason: "malformed" };
  const parts = token.slice(AGENT_CREDENTIAL_PREFIX.length).split(".");
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || header !== HEADER || payload === undefined || signature === undefined) {
    return { ok: false, reason: "malformed" };
  }
  const expected = sign(`${header}.${payload}`, secret);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  try {
    const claims = agentCredentialClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return claims.success ? { ok: true, claims: claims.data } : { ok: false, reason: "malformed" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** The only form of a token that is ever stored: lowercase sha256 hex. */
export function hashCredentialToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
