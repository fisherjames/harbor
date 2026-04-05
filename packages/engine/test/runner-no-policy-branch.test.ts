import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "@harbor/harness";
import type { ModelProvider, RunPersistence, WorkflowRunRequest } from "../src/index.js";

vi.mock("@harbor/harness", async () => {
  const actual = await vi.importActual<typeof import("@harbor/harness")>("@harbor/harness");

  return {
    ...actual,
    runLintAtExecutionPoint: () => ({
      point: "runtime-pre-stage" as const,
      report: {
        findings: [],
        blocked: false
      }
    })
  };
});

class NoopPersistence implements RunPersistence {
  async createRun(): Promise<string> {
    return "run_no_policy";
  }

  async updateStatus(): Promise<void> {
    return;
  }

  async addLintFindings(): Promise<void> {
    return;
  }

  async appendStage(): Promise<void> {
    return;
  }

  async storeArtifact(): Promise<void> {
    return;
  }
}

const request: WorkflowRunRequest = {
  tenantId: "tenant",
  workspaceId: "workspace",
  workflowId: "wf",
  trigger: "manual",
  input: {},
  actorId: "actor"
};

const workflowWithoutMemoryPolicy: WorkflowDefinition = {
  id: "wf",
  name: "workflow",
  version: 1,
  objective: "complete run",
  systemPrompt: "follow the task",
  memoryPolicy: undefined,
  nodes: [
    { id: "plan", type: "planner", owner: "ops", timeoutMs: 200, retryLimit: 0 },
    { id: "execute", type: "executor", owner: "ops", timeoutMs: 200, retryLimit: 0 },
    { id: "verify", type: "verifier", owner: "ops", timeoutMs: 200, retryLimit: 0 }
  ]
};

describe("runner memory-policy guard branch", () => {
  it("skips memory retrieval/write when memory policy is absent", async () => {
    const { createWorkflowRunner } = await import("../src/index.js");

    let memuReadCalls = 0;
    let memuWriteCalls = 0;

    const memu = {
      async readContext() {
        memuReadCalls += 1;
        return { items: [], compressedPrompt: "unused" };
      },
      async writeMemory() {
        memuWriteCalls += 1;
        return { memoryId: "m1" };
      },
      async healthcheck() {
        return { ok: true, latencyMs: 1 };
      }
    };

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const tracer = {
      stageStart() {
        return;
      },
      stageEnd() {
        return;
      },
      finding() {
        return;
      },
      error() {
        return;
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence: new NoopPersistence(),
      tracer
    });

    const result = await runner.runWorkflow(request, workflowWithoutMemoryPolicy);

    expect(result.status).toBe("completed");
    expect(memuReadCalls).toBe(0);
    expect(memuWriteCalls).toBe(0);
  });
});
