import { describe, expect, it } from "vitest";
import { assertTenantScope, InMemoryRunPersistence } from "../src/index.js";

const workflow = {
  id: "wf_1",
  name: "Demo",
  version: 1,
  objective: "obj",
  systemPrompt: "sys",
  memoryPolicy: {
    retrievalMode: "monitor",
    maxContextItems: 5,
    writebackEnabled: true,
    piiRetention: "redacted"
  },
  nodes: [
    {
      id: "plan",
      type: "planner",
      owner: "ops",
      timeoutMs: 100,
      retryLimit: 1
    },
    {
      id: "verify",
      type: "verifier",
      owner: "ops",
      timeoutMs: 100,
      retryLimit: 1
    }
  ]
} as const;

describe("tenant scope assertions", () => {
  it("accepts valid scope", () => {
    expect(() => assertTenantScope({ tenantId: "t", workspaceId: "w" })).not.toThrow();
  });

  it("rejects empty tenant or workspace", () => {
    expect(() => assertTenantScope({ tenantId: "", workspaceId: "w" })).toThrow("tenantId");
    expect(() => assertTenantScope({ tenantId: "t", workspaceId: "" })).toThrow("workspaceId");
  });
});

describe("InMemoryRunPersistence", () => {
  it("stores run lifecycle state", async () => {
    const persistence = new InMemoryRunPersistence();
    const runId = await persistence.createRun(
      {
        tenantId: "t",
        workspaceId: "w",
        workflowId: workflow.id,
        trigger: "manual",
        input: {},
        actorId: "u"
      },
      workflow
    );

    await persistence.updateStatus(runId, "running", { started: true });
    await persistence.addLintFindings(runId, []);
    await persistence.appendStage(runId, {
      stage: "plan",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      prompt: "p",
      output: "o",
      attempts: 1,
      lintFindings: []
    });
    await persistence.storeArtifact(runId, "result", "done");

    const snapshot = persistence.getSnapshot(runId);
    expect(snapshot.status).toBe("running");
    expect(snapshot.details).toEqual({ started: true });
    expect(snapshot.stages).toHaveLength(1);
    expect(snapshot.artifacts.result).toBe("done");
  });

  it("throws for unknown run id", async () => {
    const persistence = new InMemoryRunPersistence();
    await expect(persistence.updateStatus("missing", "running")).rejects.toThrow("Unknown runId");
  });
});
