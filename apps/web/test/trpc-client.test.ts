import { describe, expect, it } from "vitest";
import { createBrowserTrpcClient, resolveTrpcUrl } from "../src/trpc/client";

describe("resolveTrpcUrl", () => {
  it("uses relative endpoint by default", () => {
    expect(resolveTrpcUrl()).toBe("/api/trpc");
  });

  it("normalizes trailing slash", () => {
    expect(resolveTrpcUrl("https://example.com/")).toBe("https://example.com/api/trpc");
  });
});

describe("createBrowserTrpcClient", () => {
  it("creates a typed client proxy", () => {
    const client = createBrowserTrpcClient("https://example.com");
    expect(client).toBeDefined();
  });
});
