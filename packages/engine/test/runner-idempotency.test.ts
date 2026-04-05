import { describe, expect, it } from "vitest";
import {
  createWorkflowRunner,
  type ModelProvider,
  type RunPersistence,
  type WorkflowRunRequest
} from "../src/index.js";
import type { WorkflowDefinition } from "@harbor/harness";

const workflow: WorkflowDefinition = {
  id: "wf_1",
  name: "Workflow",
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
    { id: "plan", type: "planner", owner: "ops", timeoutMs: 100, retryLimit: 0 },
    { id: "execute", type: "executor", owner: "ops", timeoutMs: 100, retryLimit: 0 },
    { id: "verify", type: "verifier", owner: "ops", timeoutMs: 100, retryLimit: 0 }
  ]
};

const request: WorkflowRunRequest = {
  tenantId: "tenant",
  workspaceId: "workspace",
  workflowId: "wf_1",
  trigger: "manual",
  input: { prompt: "hello" },
  actorId: "user"
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
      memoryId: "m1"
    };
  },
  async healthcheck() {
    return {
      ok: true,
      latencyMs: 1
    };
  }
};

describe("runner idempotency and transition keys", () => {
  it("returns existing run when idempotency key resolves", async () => {
    let modelCalls = 0;
    const model: ModelProvider = {
      async generate() {
        modelCalls += 1;
        return {
          output: "PASS",
          latencyMs: 1
        };
      }
    };

    let createRunCalls = 0;
    let updateStatusCalls = 0;
    const findings: string[] = [];

    const persistence: RunPersistence = {
      async resolveIdempotentRun() {
        return {
          runId: "run_existing",
          status: "completed",
          details: {
            output: "cached"
          }
        };
      },
      async createRun() {
        createRunCalls += 1;
        return "run_new";
      },
      async updateStatus() {
        updateStatusCalls += 1;
      },
      async addLintFindings() {
        return;
      },
      async appendStage() {
        return;
      },
      async storeArtifact() {
        return;
      }
    };

    const tracer = {
      stageStart() {
        return;
      },
      stageEnd() {
        return;
      },
      finding(event: { message: string }) {
        findings.push(event.message);
      },
      error() {
        return;
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence,
      tracer
    });

    const result = await runner.runWorkflow(
      {
        ...request,
        idempotencyKey: "idem-1"
      },
      workflow
    );

    expect(result).toEqual({
      runId: "run_existing",
      status: "completed",
      finalOutput: {
        output: "cached"
      }
    });
    expect(modelCalls).toBe(0);
    expect(createRunCalls).toBe(0);
    expect(updateStatusCalls).toBe(0);
    expect(findings).toContain("Idempotent run request deduplicated");
  });

  it("passes idempotency transition keys for status and stages", async () => {
    const statusKeys: string[] = [];
    const stageKeys: string[] = [];

    const persistence: RunPersistence = {
      async resolveIdempotentRun() {
        return null;
      },
      async resolveStageReplay() {
        return null;
      },
      async createRun() {
        return "run_transitions";
      },
      async updateStatus(_runId, _status, _details, transitionKey) {
        if (transitionKey) {
          statusKeys.push(transitionKey);
        }
      },
      async addLintFindings() {
        return;
      },
      async appendStage(_runId, _record, transitionKey) {
        if (transitionKey) {
          stageKeys.push(transitionKey);
        }
      },
      async storeArtifact() {
        return;
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
      persistence,
      tracer
    });

    const result = await runner.runWorkflow(
      {
        ...request,
        idempotencyKey: "idem-2"
      },
      workflow
    );

    expect(result.status).toBe("completed");
    expect(statusKeys).toEqual(["status:running", "status:completed"]);
    expect(stageKeys).toEqual(["stage:plan:1", "stage:execute:2", "stage:verify:3"]);
  });

  it("short-circuits stage execution when transition replay is available", async () => {
    let modelCalls = 0;
    let memuReadCalls = 0;
    let memuWriteCalls = 0;
    let appendStageCalls = 0;

    const replayByTransitionKey = new Map([
      [
        "stage:plan:1",
        {
          stage: "plan" as const,
          startedAt: "2026-04-05T00:00:00.000Z",
          completedAt: "2026-04-05T00:00:01.000Z",
          prompt: "plan replay",
          output: "replay-plan",
          attempts: 1,
          lintFindings: []
        }
      ],
      [
        "stage:execute:2",
        {
          stage: "execute" as const,
          startedAt: "2026-04-05T00:00:01.000Z",
          completedAt: "2026-04-05T00:00:02.000Z",
          prompt: "execute replay",
          output: "replay-execute",
          attempts: 1,
          lintFindings: []
        }
      ],
      [
        "stage:verify:3",
        {
          stage: "verify" as const,
          startedAt: "2026-04-05T00:00:02.000Z",
          completedAt: "2026-04-05T00:00:03.000Z",
          prompt: "verify replay",
          output: "PASS",
          attempts: 1,
          lintFindings: []
        }
      ]
    ]);

    const persistence: RunPersistence = {
      async resolveIdempotentRun() {
        return null;
      },
      async resolveStageReplay(_runId, transitionKey) {
        return replayByTransitionKey.get(transitionKey) ?? null;
      },
      async createRun() {
        return "run_stage_replay";
      },
      async updateStatus() {
        return;
      },
      async addLintFindings() {
        return;
      },
      async appendStage() {
        appendStageCalls += 1;
      },
      async storeArtifact() {
        return;
      }
    };

    const replayMemu = {
      async readContext() {
        memuReadCalls += 1;
        return {
          items: [],
          compressedPrompt: "memory"
        };
      },
      async writeMemory() {
        memuWriteCalls += 1;
        return {
          memoryId: "m1"
        };
      },
      async healthcheck() {
        return {
          ok: true,
          latencyMs: 1
        };
      }
    };

    const model: ModelProvider = {
      async generate() {
        modelCalls += 1;
        return {
          output: "PASS",
          latencyMs: 1
        };
      }
    };

    const tracerMessages: string[] = [];
    const tracer = {
      stageStart() {
        return;
      },
      stageEnd() {
        return;
      },
      finding(event: { message: string }) {
        tracerMessages.push(event.message);
      },
      error() {
        return;
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu: replayMemu,
      persistence,
      tracer
    });

    const result = await runner.runWorkflow(
      {
        ...request,
        idempotencyKey: "idem-stage-replay"
      },
      workflow
    );

    expect(result.status).toBe("completed");
    expect(result.finalOutput?.output).toBe("replay-execute");
    expect(result.finalOutput?.verification).toBe("PASS");
    expect(modelCalls).toBe(0);
    expect(memuReadCalls).toBe(0);
    expect(memuWriteCalls).toBe(0);
    expect(appendStageCalls).toBe(0);
    expect(tracerMessages.filter((message) => message === "Stage replay deduplicated by transition key")).toHaveLength(3);
  });

  it("dedupes idempotent runs without final output payload when details are absent", async () => {
    const persistence: RunPersistence = {
      async resolveIdempotentRun() {
        return {
          runId: "run_existing_no_details",
          status: "running"
        };
      },
      async createRun() {
        throw new Error("createRun should not execute");
      },
      async updateStatus() {
        return;
      },
      async addLintFindings() {
        return;
      },
      async appendStage() {
        return;
      },
      async storeArtifact() {
        return;
      }
    };

    const model: ModelProvider = {
      async generate() {
        throw new Error("generate should not execute");
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
      persistence,
      tracer
    });

    const result = await runner.runWorkflow(
      {
        ...request,
        idempotencyKey: "idem-3"
      },
      workflow
    );

    expect(result).toEqual({
      runId: "run_existing_no_details",
      status: "running"
    });
  });
});
