import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const getCurrentUser = vi.fn();
const limitAction = vi.fn();
const rpc = vi.fn();

vi.mock("../auth/current-user", () => ({ getCurrentUser: () => getCurrentUser() as unknown }));
vi.mock("../../lib/rate-limit", () => ({
  RATE_LIMIT_RULES: { onboardingUser: { name: "onboarding-user", limit: 10, windowMs: 1 } },
  limitAction: (...args: unknown[]) => limitAction(...args) as unknown,
}));
vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({ rpc: (...args: unknown[]) => rpc(...args) as unknown }),
}));

import { createWorkspaceAction } from "./actions";

function form(name: string): FormData {
  const data = new FormData();
  data.set("name", name);
  return data;
}

describe("createWorkspaceAction hands the typed name back on every failure (AGO-201)", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: "user-1" });
    limitAction.mockResolvedValue({ allowed: true });
    rpc.mockResolvedValue({ error: null });
  });

  it("on invalid input", async () => {
    const result = await createWorkspaceAction({}, form("   "));
    expect(result.error).toBeTruthy();
    expect(result.name).toBe("   ");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("when the session expired", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect(await createWorkspaceAction({}, form("Acme"))).toMatchObject({ name: "Acme" });
  });

  it("when rate limited", async () => {
    limitAction.mockResolvedValue({ allowed: false, message: "Slow down", retryAfterSeconds: 5 });
    expect(await createWorkspaceAction({}, form("Acme"))).toEqual({
      error: "Slow down",
      name: "Acme",
    });
  });

  it("when the database call fails or throws", async () => {
    rpc.mockResolvedValue({ error: { message: "boom" } });
    expect(await createWorkspaceAction({}, form("Acme"))).toMatchObject({ name: "Acme" });
    rpc.mockRejectedValue(new Error("down"));
    expect(await createWorkspaceAction({}, form("Acme"))).toMatchObject({ name: "Acme" });
  });

  it("on success returns an empty state", async () => {
    expect(await createWorkspaceAction({}, form("Acme"))).toEqual({});
  });
});
