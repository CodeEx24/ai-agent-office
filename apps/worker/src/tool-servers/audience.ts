import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { AGENT_CREDENTIAL_PREFIX } from "@ago/shared";

import type { ToolServerScope } from "./alerts.js";
import type { ToolServerTransport } from "./client.js";
import type { ToolServerLookup } from "./registry.js";
import type { ToolServerGate } from "./tool-server-gate.js";
import type { CredentialBroker } from "../credentials/credential-broker.js";
import type { ToolServerDenialReason } from "@ago/shared";

/**
 * Audience-bound tokens and the no-passthrough rule (AGO-68).
 *
 * A tool server only ever receives a token the credential broker (AGO-157) minted for that server: a short
 * signed token (`ago_tsv_<payload>.<signature>`) whose `aud` claim is the server's registered audience. The
 * signing key is the broker's secret for that server, used inside `withSecret` and never returned. The run's
 * agent credential (`ago_agt_...`), a person's session token or a token minted for another audience is never
 * forwarded: the caller cannot hand the transport a token at all (it only gets the one built here), and the
 * check below refuses anything that is not audience-bound to this server.
 */
export const TOOL_SERVER_TOKEN_PREFIX = "ago_tsv_";
export const TOOL_SERVER_TOKEN_TTL_SECONDS = 5 * 60;
const MIN_SECRET_LENGTH = 32;

export interface ToolServerTokenClaims {
  readonly aud: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly agent_id: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** Mint a token bound to one audience. Throws on a short key or an empty audience: it never signs those. */
export function mintToolServerToken(
  claims: Omit<ToolServerTokenClaims, "jti" | "iat" | "exp">,
  secret: string,
  now: Date,
): string {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("the audience signing key is too short");
  if (claims.aud === "") throw new Error("a token needs an audience");
  const iat = Math.floor(now.getTime() / 1000);
  const full: ToolServerTokenClaims = {
    ...claims,
    jti: randomUUID(),
    iat,
    exp: iat + TOOL_SERVER_TOKEN_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${TOOL_SERVER_TOKEN_PREFIX}${payload}.${signature(payload, secret).toString("base64url")}`;
}

export type TokenVerdict =
  | { readonly ok: true; readonly claims: ToolServerTokenClaims }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "bad_signature" | "wrong_audience" | "expired";
    };

function parseClaims(payload: string): ToolServerTokenClaims | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const c = value as Record<string, unknown>;
    if (
      typeof c.aud !== "string" ||
      typeof c.workspace_id !== "string" ||
      typeof c.run_id !== "string" ||
      typeof c.agent_id !== "string" ||
      typeof c.jti !== "string" ||
      typeof c.iat !== "number" ||
      typeof c.exp !== "number"
    ) {
      return null;
    }
    return c as unknown as ToolServerTokenClaims;
  } catch {
    return null;
  }
}

/** What a tool server runs on receipt. Exported so tests can play the server's side. */
export function verifyToolServerToken(
  token: string,
  secret: string,
  expected: { readonly audience: string; readonly now: Date },
): TokenVerdict {
  if (!token.startsWith(TOOL_SERVER_TOKEN_PREFIX)) return { ok: false, reason: "malformed" };
  const parts = token.slice(TOOL_SERVER_TOKEN_PREFIX.length).split(".");
  const [payload, sig] = parts;
  if (parts.length !== 2 || payload === undefined || sig === undefined) {
    return { ok: false, reason: "malformed" };
  }
  const want = signature(payload, secret);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, reason: "bad_signature" };
  }
  const claims = parseClaims(payload);
  if (claims === null) return { ok: false, reason: "malformed" };
  if (claims.aud !== expected.audience) return { ok: false, reason: "wrong_audience" };
  if (claims.exp <= Math.floor(expected.now.getTime() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

export type PassthroughReason =
  "agent_token" | "not_audience_bound" | "no_audience" | "wrong_audience" | "malformed";

/**
 * The outbound check: may this `Authorization` value be sent to the server whose audience is `audience`?
 * Refused: an agent credential, any token that is not one of ours (a session JWT, a raw key), a token with no
 * audience and a token for another audience. Reads the audience without the key; the server verifies the
 * signature.
 */
export function checkOutboundAuthorization(
  authorization: string,
  audience: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: PassthroughReason } {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization);
  const token = match?.[1];
  if (token === undefined) return { ok: false, reason: "malformed" };
  if (token.startsWith(AGENT_CREDENTIAL_PREFIX)) return { ok: false, reason: "agent_token" };
  if (!token.startsWith(TOOL_SERVER_TOKEN_PREFIX)) {
    return { ok: false, reason: "not_audience_bound" };
  }
  const payload = token.slice(TOOL_SERVER_TOKEN_PREFIX.length).split(".")[0];
  const claims = payload === undefined ? null : parseClaims(payload);
  if (claims === null) return { ok: false, reason: "malformed" };
  if (claims.aud === "") return { ok: false, reason: "no_audience" };
  if (claims.aud !== audience) return { ok: false, reason: "wrong_audience" };
  return { ok: true };
}

/** A call was refused before or while reaching the server. The message is a fixed text plus a stable code. */
export class ToolServerDeniedError extends Error {
  readonly reason: ToolServerDenialReason;
  constructor(reason: ToolServerDenialReason) {
    super(`tool server call refused (${reason})`);
    this.name = "ToolServerDeniedError";
    this.reason = reason;
  }
}

export interface ToolServerCallRequest extends ToolServerScope {
  readonly serverId: string;
  readonly toolName: string;
  /** The capability the tool needs; the broker checks the run's credential for it. */
  readonly capability: string;
  readonly input: unknown;
  /** The run's agent credential, held by the worker. Used only to ask the broker; never sent to the server. */
  readonly credentialToken: string | undefined;
}

export interface ToolServerCaller {
  call(request: ToolServerCallRequest): Promise<string>;
}

export interface ToolServerCallerDeps {
  readonly registry: ToolServerLookup;
  readonly gate: ToolServerGate;
  readonly broker: CredentialBroker;
  readonly transport: ToolServerTransport;
  readonly now?: () => Date;
}

/**
 * Call a tool on an allowlisted, unchanged server. In order: the gate (allowlist, pin, hash), then the
 * broker (the run's credential and the capability are verified, the signing key is resolved and audited),
 * then a token bound to the server's audience is minted inside the broker call and sent. The policy engine has
 * already decided this call before the loop gets here; this does not replace it.
 */
export function createToolServerCaller(deps: ToolServerCallerDeps): ToolServerCaller {
  const now = deps.now ?? (() => new Date());
  return {
    async call(request) {
      const verdict = await deps.gate.check(request, request.serverId);
      if (!verdict.ok) throw new ToolServerDeniedError(verdict.reason);
      const entry = await deps.registry.get(request.workspaceId, request.serverId);
      if (entry === null) throw new ToolServerDeniedError("server_not_allowlisted");

      return deps.broker.withSecret(
        {
          workspaceId: request.workspaceId,
          agentId: request.agentId,
          runId: request.runId,
          toolName: request.toolName,
          capability: request.capability,
          secretRef: entry.audienceSecretRef,
          credentialToken: request.credentialToken,
        },
        (secret) => {
          const authorization = `Bearer ${mintToolServerToken(
            {
              aud: entry.audience,
              workspace_id: request.workspaceId,
              run_id: request.runId,
              agent_id: request.agentId,
            },
            secret,
            now(),
          )}`;
          if (!checkOutboundAuthorization(authorization, entry.audience).ok) {
            throw new ToolServerDeniedError("passthrough_token");
          }
          return deps.transport.call({
            serverId: request.serverId,
            toolName: request.toolName,
            input: request.input,
            authorization,
          });
        },
      );
    },
  };
}
