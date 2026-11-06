import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// Direct calls to the local Supabase Data API, for tests that check what the database allows
// regardless of what the UI shows (RLS, grants, the onboarding RPC). Local stack only.
// Keys come from the environment or from `supabase status`; nothing is hard-coded or committed.

const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:44321";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface StackKeys {
  anon: string;
  serviceRole: string;
}

let cachedKeys: StackKeys | undefined;

function stackKeys(): StackKeys {
  if (cachedKeys) return cachedKeys;
  const anonFromEnv = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceFromEnv = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  if (anonFromEnv && serviceFromEnv) {
    cachedKeys = { anon: anonFromEnv, serviceRole: serviceFromEnv };
    return cachedKeys;
  }
  const raw = execSync("pnpm exec supabase status -o json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const status = JSON.parse(raw.slice(raw.indexOf("{"))) as {
    ANON_KEY: string;
    SERVICE_ROLE_KEY: string;
  };
  cachedKeys = {
    anon: anonFromEnv ?? status.ANON_KEY,
    serviceRole: serviceFromEnv ?? status.SERVICE_ROLE_KEY,
  };
  return cachedKeys;
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

interface RequestInitLite {
  method?: string;
  body?: unknown;
  prefer?: string;
  /** Extra request headers, e.g. `Accept-Profile` to probe which schemas the Data API exposes. */
  headers?: Record<string, string>;
}

async function call<T>(
  path: string,
  key: string,
  bearer: string,
  init: RequestInitLite = {},
): Promise<ApiResult<T>> {
  const response = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      ...(init.prefer ? { prefer: init.prefer } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Creates a confirmed user with a password (local stack has confirmations off) and signs in. */
export async function createUser(label: string): Promise<TestUser> {
  const { anon } = stackKeys();
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const result = await call<{ access_token: string; user: { id: string } }>(
    "/auth/v1/signup",
    anon,
    anon,
    { method: "POST", body: { email, password: `Pw-${randomUUID()}` } },
  );
  if (result.status !== 200) throw new Error(`sign-up failed: ${String(result.status)}`);
  return { id: result.body.user.id, email, accessToken: result.body.access_token };
}

/** A request made as `user` (their JWT with the anon key), exactly like a browser client. */
export function asUser<T = unknown>(user: TestUser, path: string, init?: RequestInitLite) {
  return call<T>(path, stackKeys().anon, user.accessToken, init);
}

/** A request with no user at all (anon key only). */
export function asAnon<T = unknown>(path: string, init?: RequestInitLite) {
  const { anon } = stackKeys();
  return call<T>(path, anon, anon, init);
}

/** A request as service_role. Test setup and ground-truth reads only: it bypasses RLS. */
export function asServiceRole<T = unknown>(path: string, init?: RequestInitLite) {
  const { serviceRole } = stackKeys();
  return call<T>(path, serviceRole, serviceRole, init);
}

export type WorkspaceRole = "owner" | "member" | "viewer";

interface MemberRow {
  workspace_id: string;
  user_id: string;
  role: string;
  removed_at: string | null;
}

/** Onboards `user` through the real RPC and returns their workspace id. */
export async function onboard(user: TestUser, name: string): Promise<string> {
  const result = await asUser<string>(user, "/rest/v1/rpc/onboard_current_user", {
    method: "POST",
    body: { p_workspace_name: name },
  });
  if (result.status !== 200) throw new Error(`onboarding failed: ${String(result.status)}`);
  return result.body;
}

/** Adds `user` to a workspace with `role` (service_role: the API offers no way to do this). */
export async function addMember(workspaceId: string, user: TestUser, role: WorkspaceRole) {
  const result = await asServiceRole("/rest/v1/members", {
    method: "POST",
    body: { workspace_id: workspaceId, user_id: user.id, role },
  });
  if (result.status !== 201) throw new Error(`addMember failed: ${String(result.status)}`);
}

/** Soft-removes a member, as the future removal flow (AGO-112) will. */
export async function softRemove(workspaceId: string, user: TestUser) {
  const result = await asServiceRole(
    `/rest/v1/members?workspace_id=eq.${workspaceId}&user_id=eq.${user.id}`,
    { method: "PATCH", body: { removed_at: new Date().toISOString() } },
  );
  if (result.status !== 204) throw new Error(`softRemove failed: ${String(result.status)}`);
}

/** The truth about memberships, read with service_role. */
export async function membershipsOf(userId: string): Promise<MemberRow[]> {
  const result = await asServiceRole<MemberRow[]>(
    `/rest/v1/members?user_id=eq.${userId}&select=workspace_id,user_id,role,removed_at`,
  );
  return result.body;
}

export async function workspaceName(workspaceId: string): Promise<string | undefined> {
  const result = await asServiceRole<{ name: string }[]>(
    `/rest/v1/workspaces?id=eq.${workspaceId}&select=name`,
  );
  return result.body[0]?.name;
}

export async function roleInWorkspace(
  workspaceId: string,
  userId: string,
): Promise<string | undefined> {
  const result = await asServiceRole<{ role: string }[]>(
    `/rest/v1/members?workspace_id=eq.${workspaceId}&user_id=eq.${userId}&select=role`,
  );
  return result.body[0]?.role;
}
