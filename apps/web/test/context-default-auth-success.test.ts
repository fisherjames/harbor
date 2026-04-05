import { afterEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn<() => Promise<{ userId: string | undefined; orgId: string | undefined }>>(async () => ({
  userId: "default-user",
  orgId: "default-org"
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: authMock
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  authMock.mockClear();
});

describe("default auth provider success path", () => {
  it("uses Clerk auth values when no custom auth provider is supplied", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { createTrpcContext } = await import("../src/server/context");

    const context = await createTrpcContext({ headers: new Headers() });

    expect(authMock).toHaveBeenCalledOnce();
    expect(context).toEqual({
      tenantId: "default-org",
      workspaceId: "default-org",
      actorId: "default-user"
    });
  });

  it("normalizes undefined auth fields and falls back to headers", async () => {
    authMock.mockResolvedValueOnce({
      userId: undefined,
      orgId: undefined
    });

    vi.stubEnv("NODE_ENV", "production");
    const { createTrpcContext } = await import("../src/server/context");

    const context = await createTrpcContext({
      headers: new Headers({
        "x-harbor-tenant-id": "tenant",
        "x-harbor-workspace-id": "workspace",
        "x-harbor-actor-id": "actor"
      })
    });

    expect(context).toEqual({
      tenantId: "tenant",
      workspaceId: "workspace",
      actorId: "actor"
    });
  });
});
