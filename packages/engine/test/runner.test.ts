import { describe, expect, it } from "vitest";
import { createWorkflowRunner, type ModelProvider, type RunPersistence, type WorkflowRunRequest } from "../src/index.js";
import type { WorkflowDefinition } from "@harbor/harness";

class InMemoryPersistence implements RunPersistence {
  public readonly stages: { runId: string; prompt: string; stage: string }[] = [];
  public readonly artifacts: Record<string, string> = {};
  public status: string = "queued";

  async createRun(): Promise<string> {
    return "run_1";
  }

  async updateStatus(_runId: string, status: string): Promise<void> {
    this.status = status;
  }

  async addLintFindings(): Promise<void> {
    return;
  }

  async appendStage(runId: string, record: { stage: string; prompt: string }): Promise<void> {
    this.stages.push({ runId, stage: record.stage, prompt: record.prompt });
  }

  async storeArtifact(_runId: string, name: string, value: string): Promise<void> {
    this.artifacts[name] = value;
  }
}

const baseRequest: WorkflowRunRequest = {
  tenantId: "t_1",
  workspaceId: "w_1",
  workflowId: "wf_1",
  trigger: "manual",
  input: { problem: "demo" },
  actorId: "u_1"
};

const passingWorkflow: WorkflowDefinition = {
  id: "wf_1",
  name: "Workflow",
  version: 1,
  objective: "answer",
  systemPrompt: "be helpful",
  memoryPolicy: {
    retrievalMode: "monitor",
    maxContextItems: 8,
    writebackEnabled: true,
    piiRetention: "redacted"
  },
  nodes: [
    { id: "plan", type: "planner", owner: "ops", timeoutMs: 500, retryLimit: 0 },
    { id: "execute", type: "executor", owner: "ops", timeoutMs: 500, retryLimit: 0 },
    { id: "verify", type: "verifier", owner: "ops", timeoutMs: 500, retryLimit: 0 }
  ]
};

const memu = {
  async readContext() {
    return { items: [], compressedPrompt: "memory context" };
  },
  async writeMemory() {
    return { memoryId: "m_1" };
  },
  async healthcheck() {
    return { ok: true, latencyMs: 1 };
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

describe("createWorkflowRunner", () => {
  it("blocks execution on critical lint findings", async () => {
    const persistence = new InMemoryPersistence();

    const model: ModelProvider = {
      async generate() {
        return { output: "PASS", latencyMs: 1 };
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence,
      tracer
    });

    const result = await runner.runWorkflow(baseRequest, {
      ...passingWorkflow,
      nodes: passingWorkflow.nodes.filter((node) => node.type !== "verifier")
    });

    expect(result.status).toBe("failed");
    expect(persistence.stages).toHaveLength(0);
  });

  it("injects non-critical lint resolution steps into prompts", async () => {
    const persistence = new InMemoryPersistence();

    const model: ModelProvider = {
      async generate({ stage }) {
        if (stage === "verify") {
          return { output: "PASS", latencyMs: 1 };
        }
        return { output: `ok-${stage}`, latencyMs: 1 };
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence,
      tracer
    });

    const result = await runner.runWorkflow(baseRequest, {
      ...passingWorkflow,
      nodes: [
        { id: "plan", type: "planner", owner: "ops", timeoutMs: 500 },
        { id: "execute", type: "executor", owner: "ops", timeoutMs: 500 },
        { id: "verify", type: "verifier", owner: "ops", timeoutMs: 500 }
      ]
    });

    expect(result.status).toBe("completed");
    expect(persistence.stages.some((stage) => stage.prompt.includes("## Harness Resolution Steps"))).toBe(true);
    const summary = JSON.parse(persistence.artifacts["post-run-lint-summary"]) as Record<
      string,
      { count: number; latestVersion: number }
    >;
    expect(summary.HAR003.count).toBeGreaterThan(0);

    const recommendations = JSON.parse(
      persistence.artifacts["post-run-remediation-recommendations"]
    ) as Array<{ ruleId: string; templateTarget: string; promotionCandidate: boolean }>;
    expect(recommendations.some((item) => item.ruleId === "HAR003")).toBe(true);
    expect(recommendations.some((item) => item.templateTarget === "budgeting")).toBe(true);
    expect(recommendations.some((item) => item.promotionCandidate === true)).toBe(true);
  });

  it("uses fallback memory context and records token usage fields", async () => {
    const stageRecords: Array<{ stage: string; prompt: string; tokenUsage?: { totalTokens: number } }> = [];

    const persistence: RunPersistence = {
      async createRun() {
        return "run_token_usage";
      },
      async updateStatus() {
        return;
      },
      async addLintFindings() {
        return;
      },
      async appendStage(_runId, record) {
        stageRecords.push(record as { stage: string; prompt: string; tokenUsage?: { totalTokens: number } });
      },
      async storeArtifact() {
        return;
      }
    };

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : `ok-${stage}`,
          latencyMs: 1,
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15
          }
        };
      }
    };

    const memuWithItemOnlyContext = {
      async readContext() {
        return {
          items: [{ id: "m1", title: "history", content: "prior context", relevance: 0.8 }]
        };
      },
      async writeMemory() {
        return { memoryId: "m_1" };
      },
      async healthcheck() {
        return { ok: true, latencyMs: 1 };
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu: memuWithItemOnlyContext,
      persistence,
      tracer
    });

    const result = await runner.runWorkflow(baseRequest, {
      ...passingWorkflow,
      nodes: [
        { id: "plan", type: "planner", owner: "ops" },
        { id: "execute", type: "executor", owner: "ops", timeoutMs: 500, retryLimit: 0 },
        { id: "verify", type: "verifier", owner: "ops", timeoutMs: 500, retryLimit: 0 }
      ]
    });

    expect(result.status).toBe("completed");
    expect(stageRecords.some((record) => record.prompt.includes("## Memory Context"))).toBe(true);
    expect(stageRecords.some((record) => record.tokenUsage?.totalTokens === 15)).toBe(true);
  });
});
