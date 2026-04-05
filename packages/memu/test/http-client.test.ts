import { describe, expect, it, vi } from "vitest";
import { HttpMemuClient } from "../src/http/client.js";

describe("HttpMemuClient", () => {
  it("reads context from memU endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ id: "1", title: "t", content: "c", relevance: 0.9 }]
        }),
        { status: 200 }
      )
    );

    const client = new HttpMemuClient({ endpoint: "https://memu.example", fetchImpl });
    const result = await client.readContext({
      tenantId: "tenant",
      workspaceId: "ws",
      agentId: "agent",
      query: "test"
    });

    expect(result.items).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries transient errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("fail", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, latencyMs: 10 }), { status: 200 }));

    const client = new HttpMemuClient({ endpoint: "https://memu.example", fetchImpl, retries: 1 });
    const health = await client.healthcheck();

    expect(health.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws when request remains failing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const client = new HttpMemuClient({ endpoint: "https://memu.example", fetchImpl, retries: 0 });

    await expect(
      client.writeMemory({
        tenantId: "tenant",
        workspaceId: "ws",
        agentId: "agent",
        category: "c",
        path: "p",
        content: "x"
      })
    ).rejects.toThrow("memU request failed (400)");
  });

  it("uses unknown error fallback when response body is empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const client = new HttpMemuClient({ endpoint: "https://memu.example", fetchImpl, retries: 0 });

    await expect(
      client.writeMemory({
        tenantId: "tenant",
        workspaceId: "ws",
        agentId: "agent",
        category: "c",
        path: "p",
        content: "x"
      })
    ).rejects.toThrow("unknown error");
  });

  it("writes memory and parses response payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ memoryId: "mem_123" }), { status: 200 }));
    const client = new HttpMemuClient({ endpoint: "https://memu.example", fetchImpl, retries: 0 });

    const result = await client.writeMemory({
      tenantId: "tenant",
      workspaceId: "ws",
      agentId: "agent",
      category: "c",
      path: "p",
      content: "x"
    });

    expect(result.memoryId).toBe("mem_123");
  });

  it("attaches auth and signature headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, latencyMs: 1 }), { status: 200 }));
    const client = new HttpMemuClient({
      endpoint: "https://memu.example",
      fetchImpl,
      apiKey: "k1",
      signingSecret: "s1"
    });

    await client.healthcheck();

    const [, requestInit] = fetchImpl.mock.calls[0];
    const headers = requestInit.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k1");
    expect(headers["x-harbor-signature"]).toBeTypeOf("string");
  });

  it("handles aborted requests with retries", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("aborted"));
    const client = new HttpMemuClient({ endpoint: "https://memu.example", fetchImpl, retries: 1 });

    await expect(client.healthcheck()).rejects.toThrow("aborted");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("handles 204 responses through request path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new HttpMemuClient({ endpoint: "https://memu.example", fetchImpl, retries: 0 });

    await expect(
      client.readContext({
        tenantId: "tenant",
        workspaceId: "ws",
        agentId: "agent",
        query: "test"
      })
    ).rejects.toThrow();
  });
});
