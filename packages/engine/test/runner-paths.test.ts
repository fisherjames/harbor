import { describe, expect, it } from "vitest";
import { createWorkflowRunner, type ModelProvider, type RunPersistence, type WorkflowRunRequest } from "../src/index.js";
import type { WorkflowDefinition } from "@harbor/harness";

class CapturePersistence implements RunPersistence {
  public status: string = "queued";
  public artifacts: Record<string, string> = {};
  public stages: string[] = [];

  async createRun(): Promise<string> {
    return "run_path";
  }

  async updateStatus(_runId: string, status: string): Promise<void> {
    this.status = status;
  }

  async addLintFindings(): Promise<void> {
    return;
  }

  async appendStage(_runId: string, record: { stage: string }): Promise<void> {
    this.stages.push(record.stage);
  }

  async storeArtifact(_runId: string, name: string, value: string): Promise<void> {
    this.artifacts[name] = value;
  }
}

const request: WorkflowRunRequest = {
  tenantId: "tenant",
  workspaceId: "workspace",
  workflowId: "wf_1",
  trigger: "manual",
  input: {
    q: "hi"
  },
  actorId: "user"
};

const workflow: WorkflowDefinition = {
  id: "wf_1",
  name: "workflow",
  version: 1,
  objective: "do work",
  systemPrompt: "be precise",
  memoryPolicy: {
    retrievalMode: "monitor",
    maxContextItems: 4,
    writebackEnabled: true,
    piiRetention: "redacted"
  },
  nodes: [
    { id: "plan", type: "planner", owner: "ops", timeoutMs: 100, retryLimit: 0 },
    { id: "execute", type: "executor", owner: "ops", timeoutMs: 100, retryLimit: 0 },
    { id: "verify", type: "verifier", owner: "ops", timeoutMs: 100, retryLimit: 0 }
  ]
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

const memu = {
  async readContext() {
    return {
      items: [],
      compressedPrompt: "memory"
    };
  },
  async writeMemory() {
    return {
      memoryId: "m"
    };
  },
  async healthcheck() {
    return {
      ok: true,
      latencyMs: 1
    };
  }
};

describe("workflow runner paths", () => {
  it("enters fix path and completes", async () => {
    const outputs: string[] = ["plan", "execute", "FAIL", "fixed", "PASS"];
    const model: ModelProvider = {
      async generate() {
        const output = outputs.shift();
        return {
          output: output ?? "PASS",
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence, maxFixAttempts: 1 });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("completed");
    expect(persistence.stages).toEqual(["plan", "execute", "verify", "fix", "verify"]);
  });

  it("escalates to needs_human when verify keeps failing", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "FAIL" : "ok",
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence, maxFixAttempts: 1 });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("needs_human");
    expect(persistence.status).toBe("needs_human");
    expect(Object.keys(persistence.artifacts).some((name) => name.startsWith("verify-failure"))).toBe(true);
  });

  it("marks run failed when model throws", async () => {
    const model: ModelProvider = {
      async generate() {
        throw new Error("model down");
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("failed");
    expect(persistence.status).toBe("failed");
  });

  it("stores deduplicated harness resolution steps for warning findings", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const warningWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: workflow.nodes.map((node) => {
        const { timeoutMs: _timeoutMs, retryLimit: _retryLimit, ...rest } = node;
        return rest;
      })
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });

    const result = await runner.runWorkflow(request, warningWorkflow);
    expect(result.status).toBe("completed");

    const rawSteps = persistence.artifacts["harness-resolution-steps"];
    expect(rawSteps).toBeDefined();

    const steps = JSON.parse(rawSteps ?? "[]") as string[];
    expect(steps.some((step) => step.includes("timeoutMs and retryLimit"))).toBe(true);
    expect(steps.filter((step) => step === "Escalate to human after retry budget exhaustion.")).toHaveLength(1);
  });

  it("records tool execution policy artifact when tool nodes are present", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const workflowWithTool: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          id: "tool-node",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["search"],
          toolCallPolicy: {
            timeoutMs: 500,
            retryLimit: 1,
            maxCalls: 2
          }
        }
      ]
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });
    const result = await runner.runWorkflow(request, workflowWithTool);

    expect(result.status).toBe("completed");
    const rawPolicy = persistence.artifacts["tool-execution-policy"];
    expect(rawPolicy).toBeDefined();

    const policy = JSON.parse(rawPolicy ?? "[]") as Array<{ nodeId: string; maxCalls: number | null }>;
    expect(policy[0]?.nodeId).toBe("tool-node");
    expect(policy[0]?.maxCalls).toBe(2);
  });

  it("captures defaulted tool policy fields even when lint blocks the run", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const blockedToolWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          id: "unsafe-tool",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1
        }
      ]
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });
    const result = await runner.runWorkflow(request, blockedToolWorkflow);

    expect(result.status).toBe("failed");
    const rawPolicy = persistence.artifacts["tool-execution-policy"];
    expect(rawPolicy).toBeDefined();

    const policy = JSON.parse(rawPolicy ?? "[]") as Array<{
      nodeId: string;
      scope: string[];
      timeoutMs: number | null;
      retryLimit: number | null;
      maxCalls: number | null;
    }>;

    expect(policy[0]?.nodeId).toBe("unsafe-tool");
    expect(policy[0]?.scope).toEqual([]);
    expect(policy[0]?.timeoutMs).toBeNull();
    expect(policy[0]?.retryLimit).toBeNull();
    expect(policy[0]?.maxCalls).toBeNull();
  });

  it("blocks runs without memory policy and skips memu reads/writes", async () => {
    let memuReadCalls = 0;
    let memuWriteCalls = 0;

    const noMemoryMemu = {
      async readContext() {
        memuReadCalls += 1;
        return { items: [], compressedPrompt: "" };
      },
      async writeMemory() {
        memuWriteCalls += 1;
        return { memoryId: "m" };
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

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu: noMemoryMemu, tracer, persistence });

    const result = await runner.runWorkflow(request, {
      ...workflow,
      memoryPolicy: undefined
    });

    expect(result.status).toBe("failed");
    expect(memuReadCalls).toBe(0);
    expect(memuWriteCalls).toBe(0);
  });
});
