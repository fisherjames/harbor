import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("dependency memu resolution", () => {
  it("builds router when managed memu env vars are configured", async () => {
    vi.stubEnv("MEMU_ENDPOINT", "https://memu.example");
    vi.stubEnv("MEMU_API_KEY", "k1");
    vi.stubEnv("MEMU_SIGNING_SECRET", "s1");

    const { getAppRouter, resetRouterForTests } = await import("../src/server/dependencies");
    resetRouterForTests();

    const router = getAppRouter();
    expect(router).toBeDefined();
  });

  it("builds router with endpoint-only memu configuration", async () => {
    vi.stubEnv("MEMU_ENDPOINT", "https://memu.example");

    const { getAppRouter, resetRouterForTests } = await import("../src/server/dependencies");
    resetRouterForTests();

    const router = getAppRouter();
    expect(router).toBeDefined();
  });

  it("builds router with postgres run-store branch when DATABASE_URL is set", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://harbor:harbor@localhost:5432/harbor");

    const { getAppRouter, resetRouterForTests } = await import("../src/server/dependencies");
    resetRouterForTests();

    const router = getAppRouter();
    expect(router).toBeDefined();
  });
});
