import { afterEach, describe, expect, it, vi } from "vitest";
import { contextFromHeaders, createTrpcContext } from "../src/server/context";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("contextFromHeaders", () => {
  it("extracts tenancy headers", () => {
    const headers = new Headers({
      "x-harbor-tenant-id": "tenant",
      "x-harbor-workspace-id": "workspace",
      "x-harbor-actor-id": "actor"
    });

    expect(contextFromHeaders(headers)).toEqual({
      tenantId: "tenant",
      workspaceId: "workspace",
      actorId: "actor"
    });
  });
});

describe("createTrpcContext", () => {
  it("uses auth identity when present", async () => {
    const context = await createTrpcContext({
      authProvider: async () => ({
        userId: "u1",
        orgId: "org1"
      }),
      headers: new Headers()
    });

    expect(context).toEqual({
      tenantId: "org1",
      workspaceId: "org1",
      actorId: "u1"
    });
  });

  it("supports default empty-header source when no request/headers are provided", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const context = await createTrpcContext({
      authProvider: async () => ({
        userId: "u2",
        orgId: "org2"
      })
    });

    expect(context).toEqual({
      tenantId: "org2",
      workspaceId: "org2",
      actorId: "u2"
    });
  });

  it("uses header fallback in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const context = await createTrpcContext({
      authProvider: async () => ({ userId: null, orgId: null }),
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

  it("throws in production when context cannot be derived", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      createTrpcContext({
        authProvider: async () => ({ userId: null, orgId: null }),
        headers: new Headers()
      })
    ).rejects.toThrow("Unable to establish tenancy context");
  });

  it("uses request headers when explicit headers are not passed", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const request = new Request("http://localhost/api/trpc/saveWorkflow", {
      headers: {
        "x-harbor-tenant-id": "tenant-from-request",
        "x-harbor-workspace-id": "workspace-from-request",
        "x-harbor-actor-id": "actor-from-request"
      }
    });

    const context = await createTrpcContext({
      authProvider: async () => ({ userId: null, orgId: null }),
      request
    });

    expect(context).toEqual({
      tenantId: "tenant-from-request",
      workspaceId: "workspace-from-request",
      actorId: "actor-from-request"
    });
  });
});
