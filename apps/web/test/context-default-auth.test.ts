import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => {
    throw new Error("no clerk session");
  })
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("default auth provider", () => {
  it("falls back to dev context when Clerk auth throws", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { createTrpcContext } = await import("../src/server/context");

    const context = await createTrpcContext({ headers: new Headers() });

    expect(context).toEqual({
      tenantId: "dev-tenant",
      workspaceId: "dev-workspace",
      actorId: "dev-user"
    });
  });
});
