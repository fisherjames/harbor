import { afterEach, describe, expect, it, vi } from "vitest";
import { functions, inngest, workflowRunRequested } from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("worker exports", () => {
  it("exports inngest client and functions array", () => {
    expect(inngest).toBeDefined();
    expect(Array.isArray(functions)).toBe(true);
    expect(functions.length).toBeGreaterThan(0);
  });

  it("runs workflow handler", async () => {
    const result = await workflowRunRequested.fn({
      event: {
        data: {
          request: {
            tenantId: "t1",
            workspaceId: "w1",
            workflowId: "wf_1",
            trigger: "manual",
            input: {
              prompt: "hello"
            },
            actorId: "u1"
          },
          workflow: {
            id: "wf_1",
            name: "Demo",
            version: 1,
            objective: "obj",
            systemPrompt: "sys",
            memoryPolicy: {
              retrievalMode: "monitor",
              maxContextItems: 4,
              writebackEnabled: true,
              piiRetention: "redacted"
            },
            nodes: [
              { id: "plan", type: "planner", owner: "ops", timeoutMs: 50, retryLimit: 0 },
              { id: "execute", type: "executor", owner: "ops", timeoutMs: 50, retryLimit: 0 },
              { id: "verify", type: "verifier", owner: "ops", timeoutMs: 50, retryLimit: 0 }
            ]
          }
        }
      }
    });

    expect(result.status).toBe("completed");
  });

  it("initializes with managed memu branch when endpoint is set", async () => {
    vi.stubEnv("MEMU_ENDPOINT", "https://memu.example");
    const module = await import("../src/inngest.js");

    expect(module.inngest).toBeDefined();
    expect(module.functions.length).toBeGreaterThan(0);
  });

  it("passes optional memu credentials when configured", async () => {
    vi.stubEnv("MEMU_ENDPOINT", "https://memu.example");
    vi.stubEnv("MEMU_API_KEY", "k1");
    vi.stubEnv("MEMU_SIGNING_SECRET", "s1");

    const module = await import("../src/inngest.js");
    expect(module.workflowRunRequested).toBeDefined();
  });
});
