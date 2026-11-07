// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ requestHeaders: new Headers() }));
const listCapabilities = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(state.requestHeaders) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../../features/capabilities/capability-catalog", () => {
  class CapabilityCatalogError extends Error {}
  return { CapabilityCatalogError, listCapabilities };
});
vi.mock("../../features/workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {}
  return { WorkspaceAccessError };
});
vi.mock("../../features/agents/agent-library", () => {
  class AgentLibraryError extends Error {}
  return { AgentLibraryError, agentCreator: { create: vi.fn() } };
});

import { GET as getCapabilities } from "../../app/api/capabilities/route";
import { createAgentAction } from "../../features/agents/actions";
import { proxy } from "../../proxy";
import {
  AgentCredentialRejectedError,
  assertHumanRequest,
  rejectAgentCredential,
  requireHumanRequest,
} from "./human-only";

const AGENT_TOKEN =
  "ago_agt_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload-part-here.signature-part-here";
const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const withAgentToken = (init: Record<string, string> = {}) => ({
  ...init,
  authorization: `Bearer ${AGENT_TOKEN}`,
});

beforeEach(() => {
  state.requestHeaders = new Headers();
  listCapabilities.mockReset();
});

describe("assertHumanRequest / requireHumanRequest", () => {
  it("lets a request without an agent credential through", async () => {
    expect(() => {
      assertHumanRequest(new Headers());
    }).not.toThrow();
    expect(() => {
      assertHumanRequest(new Headers({ authorization: "Bearer eyJabc.def.ghi" }));
    }).not.toThrow();
    await expect(requireHumanRequest()).resolves.toBeUndefined();
  });

  it("rejects an agent credential, in any spelling of the scheme", async () => {
    expect(() => {
      assertHumanRequest(new Headers(withAgentToken()));
    }).toThrow(AgentCredentialRejectedError);
    expect(() => {
      assertHumanRequest(new Headers({ authorization: `bearer ${AGENT_TOKEN}` }));
    }).toThrow(AgentCredentialRejectedError);
    state.requestHeaders = new Headers(withAgentToken());
    await expect(requireHumanRequest()).rejects.toBeInstanceOf(AgentCredentialRejectedError);
  });

  it("rejects it even when the request also carries a human session cookie", () => {
    expect(() => {
      assertHumanRequest(
        new Headers(withAgentToken({ cookie: "sb-session=a-valid-human-session" })),
      );
    }).toThrow(AgentCredentialRejectedError);
  });
});

describe("rejectAgentCredential", () => {
  it("answers 403 without echoing the credential, and never caches", async () => {
    const response = rejectAgentCredential({ headers: new Headers(withAgentToken()) });
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    const body = await response?.text();
    expect(body).toBe(JSON.stringify({ error: "agent_credential_not_allowed" }));
    expect(body).not.toContain(AGENT_TOKEN);
  });

  it("lets a human request proceed", () => {
    expect(rejectAgentCredential({ headers: new Headers() })).toBeUndefined();
  });
});

describe("AC: an agent token cannot call a human-only route or server action", () => {
  it("the proxy refuses an agent credential on every app and API route", async () => {
    for (const path of ["/app/agents", "/app/approvals", "/api/capabilities", "/"]) {
      const response = await proxy(
        new NextRequest(`http://localhost${path}`, { headers: withAgentToken() }),
      );
      expect(response.status, path).toBe(403);
      expect(response.headers.get("content-security-policy"), path).toBeTruthy();
      expect(await response.text()).not.toContain(AGENT_TOKEN);
    }
  });

  it("the capabilities route refuses an agent credential before reading anything", async () => {
    const response = await getCapabilities(
      new NextRequest(`http://localhost/api/capabilities?workspace_id=${WORKSPACE}`, {
        headers: withAgentToken(),
      }),
    );
    expect(response.status).toBe(403);
    expect(listCapabilities).not.toHaveBeenCalled();
  });

  it("the create-agent server action refuses an agent credential", async () => {
    state.requestHeaders = new Headers(withAgentToken());
    const result = await createAgentAction({}, new FormData());
    expect(result.error).toMatch(/people only/);
    expect(result.fieldErrors).toBeUndefined();
  });

  it("a person's request still reaches the action's own validation", async () => {
    const result = await createAgentAction({}, new FormData());
    expect(result.error ?? "").not.toMatch(/people only/);
    expect(result.fieldErrors ?? result.error).toBeTruthy();
  });
});
