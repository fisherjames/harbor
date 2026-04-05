import { describe, expect, it } from "vitest";
import { createInMemoryMemuClient } from "../src/index.js";

describe("InMemoryMemuClient", () => {
  it("stores and retrieves contextual memories", async () => {
    const client = createInMemoryMemuClient();

    await client.writeMemory({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      category: "workflow",
      path: "demo/1.md",
      content: "retry budget set to 2"
    });

    const context = await client.readContext({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      query: "retry"
    });

    expect(context.items).toHaveLength(1);
    expect(context.compressedPrompt).toContain("retry budget");
  });

  it("respects tenant/workspace/agent isolation", async () => {
    const client = createInMemoryMemuClient();

    await client.writeMemory({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      category: "workflow",
      path: "demo/1.md",
      content: "secret"
    });

    const context = await client.readContext({
      tenantId: "t2",
      workspaceId: "w1",
      agentId: "a1",
      query: "secret"
    });

    expect(context.items).toHaveLength(0);
    expect(context.compressedPrompt).toBeUndefined();
  });

  it("supports path matching, max item limits, and health checks", async () => {
    const client = createInMemoryMemuClient();

    await client.writeMemory({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      category: "workflow",
      path: "project/retry.md",
      content: "alpha"
    });

    await client.writeMemory({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      category: "workflow",
      path: "project/verify.md",
      content: "beta"
    });

    const context = await client.readContext({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      query: "project",
      maxItems: 1
    });

    expect(context.items).toHaveLength(1);

    const health = await client.healthcheck();
    expect(health).toEqual({ ok: true, latencyMs: 1 });
  });
});
