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
    expect(context.items[0]?.trust?.source).toBe("in-memory");
    expect(context.items[0]?.trust?.confidence).toBe(0.75);
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

  it("stores trust metadata from write input and returns it in context reads", async () => {
    const client = createInMemoryMemuClient();

    await client.writeMemory({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      category: "workflow",
      path: "project/verify.md",
      content: "validated assertion",
      metadata: {
        trustSource: "runtime:verify",
        trustConfidence: 0.92,
        lastValidatedAt: "2026-04-06T00:00:00.000Z"
      }
    });

    const context = await client.readContext({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      query: "validated"
    });

    expect(context.items[0]?.trust).toEqual({
      source: "runtime:verify",
      confidence: 0.92,
      lastValidatedAt: "2026-04-06T00:00:00.000Z"
    });
  });

  it("falls back to default trust confidence when metadata confidence is invalid", async () => {
    const client = createInMemoryMemuClient();

    await client.writeMemory({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      category: "workflow",
      path: "project/invalid-trust.md",
      content: "context",
      metadata: {
        trustSource: "runtime:execute",
        trustConfidence: "bad-number"
      }
    });

    const context = await client.readContext({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      query: "context"
    });

    expect(context.items[0]?.trust).toEqual({
      source: "runtime:execute",
      confidence: 0.75
    });
  });

  it("falls back to default trust source when metadata source is invalid", async () => {
    const client = createInMemoryMemuClient();

    await client.writeMemory({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      category: "workflow",
      path: "project/invalid-source.md",
      content: "source-check",
      metadata: {
        trustSource: 42,
        trustConfidence: 0.61
      }
    });

    const context = await client.readContext({
      tenantId: "t1",
      workspaceId: "w1",
      agentId: "a1",
      query: "source-check"
    });

    expect(context.items[0]?.trust).toEqual({
      source: "in-memory",
      confidence: 0.61
    });
  });
});
