import { describe, expect, it } from "vitest";
import {
  createWorkflowRunner,
  type ModelProvider,
  type RunIsolationManager,
  type RunPersistence,
  type WorkflowRunRequest
} from "../src/index.js";
import type { WorkflowDefinition } from "@harbor/harness";

class IsolationPersistence implements RunPersistence {
  public readonly statusUpdates: string[] = [];
  public readonly artifacts: Record<string, string> = {};
  public readonly stages: string[] = [];

  async createRun(): Promise<string> {
    return "run_isolation";
  }

  async updateStatus(_runId: string, status: string): Promise<void> {
    this.statusUpdates.push(status);
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
  workflowId: "wf_isolation",
  trigger: "manual",
  input: { prompt: "hello" },
  actorId: "user"
};

const workflow: WorkflowDefinition = {
  id: "wf_isolation",
  name: "Isolation workflow",
  version: 1,
  objective: "Run safely",
  systemPrompt: "Be precise",
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

function createTracer() {
  const errors: string[] = [];

  return {
    errors,
    tracer: {
      stageStart() {
        return;
      },
      stageEnd() {
        return;
      },
      finding() {
        return;
      },
      error(event: { message: string }) {
        errors.push(event.message);
      }
    }
  };
}

describe("workflow runner isolation lifecycle", () => {
  it("stores isolation session and tears down with completed outcome", async () => {
    const persistence = new IsolationPersistence();
    const { tracer } = createTracer();

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : `ok-${stage}`,
          latencyMs: 1
        };
      }
    };

    let teardownOutcome: string | undefined;
    const runIsolation: RunIsolationManager = {
      async setup() {
        return {
          worktreePath: "/tmp/harbor/run_isolation",
          observabilitySessionId: "obs_run_isolation",
          observabilityExpiresAt: "2026-04-05T01:00:00.000Z"
        };
      },
      async teardown(_context, _session, outcome) {
        teardownOutcome = outcome;
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence,
      tracer,
      runIsolation
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("completed");
    expect(teardownOutcome).toBe("completed");
    expect(persistence.artifacts["run-isolation-session"]).toBeDefined();

    const session = JSON.parse(persistence.artifacts["run-isolation-session"] ?? "{}") as {
      worktreePath: string;
      observabilitySessionId: string;
    };

    expect(session.worktreePath).toContain("run_isolation");
    expect(session.observabilitySessionId).toBe("obs_run_isolation");
  });

  it("fails fast when isolation setup fails", async () => {
    const persistence = new IsolationPersistence();
    const { tracer, errors } = createTracer();

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

    const runIsolation: RunIsolationManager = {
      async setup() {
        throw new Error("isolation unavailable");
      },
      async teardown() {
        throw new Error("should not run");
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence,
      tracer,
      runIsolation
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("failed");
    expect(result.finalOutput?.reason).toBe("run_isolation_setup_failed");
    expect(modelCalls).toBe(0);
    expect(persistence.artifacts["run-isolation-setup-error"]).toBe("isolation unavailable");
    expect(errors).toContain("Run isolation setup failed");
  });

  it("records teardown errors without overriding successful outcomes", async () => {
    const persistence = new IsolationPersistence();
    const { tracer, errors } = createTracer();

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const runIsolation: RunIsolationManager = {
      async setup() {
        return {
          worktreePath: "/tmp/harbor/run_isolation_teardown",
          observabilitySessionId: "obs_teardown",
          observabilityExpiresAt: "2026-04-05T01:00:00.000Z"
        };
      },
      async teardown() {
        throw new Error("cleanup failed");
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence,
      tracer,
      runIsolation
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("completed");
    expect(persistence.artifacts["run-isolation-teardown-error"]).toBe("cleanup failed");
    expect(errors).toContain("Run isolation teardown failed");
  });

  it("swallows teardown artifact write failures after recording tracer error", async () => {
    const persistence = new IsolationPersistence();
    const { tracer, errors } = createTracer();

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const runIsolation: RunIsolationManager = {
      async setup() {
        return {
          worktreePath: "/tmp/harbor/run_isolation_store_failure",
          observabilitySessionId: "obs_store_failure",
          observabilityExpiresAt: "2026-04-05T01:00:00.000Z"
        };
      },
      async teardown() {
        throw new Error("cleanup failed");
      }
    };

    const failingPersistence: RunPersistence = {
      async createRun(req, workflowDef) {
        return persistence.createRun(req, workflowDef);
      },
      async updateStatus(runId, status, details) {
        return persistence.updateStatus(runId, status, details);
      },
      async addLintFindings(runId, findings) {
        return persistence.addLintFindings(runId, findings);
      },
      async appendStage(runId, record) {
        return persistence.appendStage(runId, record);
      },
      async storeArtifact(runId, name, value) {
        if (name === "run-isolation-teardown-error") {
          throw new Error("artifact store down");
        }

        return persistence.storeArtifact(runId, name, value);
      }
    };

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence: failingPersistence,
      tracer,
      runIsolation
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("completed");
    expect(errors).toContain("Run isolation teardown failed");
  });
});
