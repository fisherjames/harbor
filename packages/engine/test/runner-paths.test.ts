import { describe, expect, it } from "vitest";
import { createWorkflowRunner, type ModelProvider, type RunPersistence, type WorkflowRunRequest } from "../src/index.js";
import type { WorkflowDefinition } from "@harbor/harness";

class CapturePersistence implements RunPersistence {
  public status: string = "queued";
  public artifacts: Record<string, string> = {};
  public stages: string[] = [];
  public stageRecords: Array<{ stage: string; confidence?: number }> = [];
  public stagePrompts: Array<{ stage: string; prompt: string }> = [];

  async createRun(): Promise<string> {
    return "run_path";
  }

  async updateStatus(_runId: string, status: string): Promise<void> {
    this.status = status;
  }

  async addLintFindings(): Promise<void> {
    return;
  }

  async appendStage(_runId: string, record: { stage: string; confidence?: number; prompt?: string }): Promise<void> {
    this.stages.push(record.stage);
    this.stageRecords.push(record);
    if (record.prompt) {
      this.stagePrompts.push({
        stage: record.stage,
        prompt: record.prompt
      });
    }
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
    expect(result.finalOutput?.reason).toBe("verification_failed");
    expect(persistence.status).toBe("needs_human");
    expect(Object.keys(persistence.artifacts).some((name) => name.startsWith("verify-failure"))).toBe(true);
  });

  it("escalates to needs_human when verify confidence is below threshold", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        if (stage === "verify") {
          return {
            output: "PASS",
            confidence: 0.42,
            confidenceRationale: "Insufficient evidence coverage.",
            latencyMs: 1
          };
        }

        return {
          output: "ok",
          confidence: 0.9,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu,
      tracer,
      persistence,
      confidenceGatePolicy: {
        threshold: 0.6,
        stages: ["verify"]
      }
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("needs_human");
    expect(result.finalOutput?.reason).toBe("confidence_gate");
    expect(result.finalOutput?.stage).toBe("verify");
    const gateArtifact = JSON.parse(persistence.artifacts["confidence-gate"] ?? "{}") as {
      stage?: string;
      threshold?: number;
      confidence?: number;
      reason?: string;
    };
    expect(gateArtifact.stage).toBe("verify");
    expect(gateArtifact.threshold).toBe(0.6);
    expect(gateArtifact.confidence).toBe(0.42);
    expect(gateArtifact.reason).toBe("confidence_below_threshold");
  });

  it("escalates to needs_human when plan confidence is below threshold", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        if (stage === "plan") {
          return {
            output: "plan drafted",
            confidence: 0.3,
            confidenceRationale: "Ambiguous upstream requirements.",
            latencyMs: 1
          };
        }

        return {
          output: "ok",
          confidence: 0.95,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu,
      tracer,
      persistence,
      confidenceGatePolicy: {
        threshold: 0.6,
        stages: ["plan"]
      }
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("needs_human");
    expect(result.finalOutput?.stage).toBe("plan");
    expect(result.finalOutput?.reason).toBe("confidence_gate");
  });

  it("escalates to needs_human when execute confidence is below threshold", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        if (stage === "execute") {
          return {
            output: "execution uncertain",
            confidence: 0.2,
            latencyMs: 1
          };
        }

        return {
          output: stage === "verify" ? "PASS" : "ok",
          confidence: 0.95,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu,
      tracer,
      persistence,
      confidenceGatePolicy: {
        threshold: 0.6,
        stages: ["execute"]
      }
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("needs_human");
    expect(result.finalOutput?.stage).toBe("execute");
    expect(result.finalOutput?.reason).toBe("confidence_gate");
  });

  it("escalates to needs_human when fix confidence is below threshold", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        if (stage === "verify") {
          return {
            output: "FAIL",
            confidence: 0.95,
            latencyMs: 1
          };
        }

        if (stage === "fix") {
          return {
            output: "patched",
            confidence: 0.4,
            confidenceRationale: "Patch quality uncertain.",
            latencyMs: 1
          };
        }

        return {
          output: "ok",
          confidence: 0.9,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu,
      tracer,
      persistence,
      confidenceGatePolicy: {
        threshold: 0.6,
        stages: ["fix"]
      },
      maxFixAttempts: 1
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("needs_human");
    expect(result.finalOutput?.reason).toBe("confidence_gate");
    expect(result.finalOutput?.stage).toBe("fix");
  });

  it("escalates to needs_human when re-verify confidence drops below threshold", async () => {
    let verifyCount = 0;

    const model: ModelProvider = {
      async generate({ stage }) {
        if (stage === "verify") {
          verifyCount += 1;
          if (verifyCount === 1) {
            return {
              output: "FAIL",
              confidence: 0.95,
              latencyMs: 1
            };
          }

          return {
            output: "PASS",
            confidence: 0.35,
            confidenceRationale: "Evidence changed after fix.",
            latencyMs: 1
          };
        }

        return {
          output: "ok",
          confidence: 0.9,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu,
      tracer,
      persistence,
      confidenceGatePolicy: {
        threshold: 0.6,
        stages: ["verify"]
      },
      maxFixAttempts: 1
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("needs_human");
    expect(result.finalOutput?.reason).toBe("confidence_gate");
    expect(result.finalOutput?.stage).toBe("verify");
    expect(verifyCount).toBe(2);
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

  it("captures two-phase preview and commit hashes for mutating tool groups", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const workflowWithTwoPhaseTooling: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          id: "tool-propose",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 500,
            retryLimit: 1,
            maxCalls: 1,
            sideEffectMode: "propose",
            phaseGroup: "payments"
          }
        },
        {
          id: "tool-commit",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 500,
            retryLimit: 1,
            maxCalls: 1,
            sideEffectMode: "commit",
            phaseGroup: "payments"
          }
        }
      ]
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });
    const result = await runner.runWorkflow(request, workflowWithTwoPhaseTooling);

    expect(result.status).toBe("completed");
    const preview = JSON.parse(persistence.artifacts["two-phase-preview-payments"] ?? "{}") as {
      previewHash?: string;
    };
    const commit = JSON.parse(persistence.artifacts["two-phase-commit-payments"] ?? "{}") as {
      commitConfirmationHash?: string;
      previewHash?: string;
    };
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(commit.commitConfirmationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(commit.previewHash).toBe(preview.previewHash);
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

  it("fails runtime when commit node appears before propose node in two-phase groups", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const misorderedTwoPhaseWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          id: "tool-commit",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 500,
            retryLimit: 1,
            maxCalls: 1,
            sideEffectMode: "commit",
            phaseGroup: "payments"
          }
        },
        {
          id: "tool-propose",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 500,
            retryLimit: 1,
            maxCalls: 1,
            sideEffectMode: "propose",
            phaseGroup: "payments"
          }
        }
      ]
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });
    const result = await runner.runWorkflow(request, misorderedTwoPhaseWorkflow);

    expect(result.status).toBe("failed");
    expect(result.finalOutput?.reason).toBe("two_phase_violation");
    expect((result.finalOutput?.details as string[]).some((reason) => reason.includes("appears before propose"))).toBe(
      true
    );
  });

  it("fails runtime when commit phase group has no propose node", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const commitOnlyWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          id: "tool-commit",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 500,
            retryLimit: 1,
            maxCalls: 1,
            sideEffectMode: "commit",
            phaseGroup: "payments"
          }
        }
      ]
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });
    const result = await runner.runWorkflow(request, commitOnlyWorkflow);

    expect(result.status).toBe("failed");
    expect(result.finalOutput?.reason).toBe("two_phase_violation");
    expect((result.finalOutput?.details as string[]).some((reason) => reason.includes("missing a propose node"))).toBe(
      true
    );
  });

  it("fails runtime when mutating tool mode is missing phaseGroup", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const missingGroupWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          id: "tool-commit",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 500,
            retryLimit: 1,
            maxCalls: 1,
            sideEffectMode: "commit"
          }
        }
      ]
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });
    const result = await runner.runWorkflow(request, missingGroupWorkflow);

    expect(result.status).toBe("failed");
    expect(result.finalOutput?.reason).toBe("two_phase_violation");
    expect((result.finalOutput?.details as string[]).some((reason) => reason.includes("without phaseGroup"))).toBe(true);
  });

  it("allows propose-only side-effect groups without commit artifacts", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          latencyMs: 1
        };
      }
    };

    const proposeOnlyWorkflow: WorkflowDefinition = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          id: "tool-propose",
          type: "tool_call",
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 500,
            retryLimit: 1,
            maxCalls: 1,
            sideEffectMode: "propose",
            phaseGroup: "payments"
          }
        }
      ]
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({ model, memu, tracer, persistence });
    const result = await runner.runWorkflow(request, proposeOnlyWorkflow);

    expect(result.status).toBe("completed");
    expect(persistence.artifacts["two-phase-preview-payments"]).toBeUndefined();
    expect(persistence.artifacts["two-phase-commit-payments"]).toBeUndefined();
  });

  it("detects memory conflicts in reason mode and injects trust remediation steps", async () => {
    const conflictMemu = {
      async readContext() {
        return {
          items: [
            {
              id: "mem-high",
              title: "policy:refund-window",
              content: "Refund window is 30 days.",
              relevance: 0.9,
              trust: {
                source: "verified_kb",
                confidence: 0.95,
                lastValidatedAt: "2026-04-05T00:00:00.000Z"
              }
            },
            {
              id: "mem-low",
              title: "policy:refund-window",
              content: "Refund window is 7 days.",
              relevance: 0.8,
              trust: {
                source: "stale_note",
                confidence: 0.2,
                lastValidatedAt: "2025-01-01T00:00:00.000Z"
              }
            }
          ]
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

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          confidence: 0.9,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu: conflictMemu,
      tracer,
      persistence
    });

    const result = await runner.runWorkflow(request, {
      ...workflow,
      memoryPolicy: {
        retrievalMode: "reason",
        maxContextItems: 4,
        writebackEnabled: true,
        piiRetention: "redacted"
      }
    });

    expect(result.status).toBe("completed");
    const planPrompt = persistence.stagePrompts.find((record) => record.stage === "plan")?.prompt ?? "";
    expect(planPrompt).toContain("Refund window is 30 days.");
    expect(planPrompt).not.toContain("Refund window is 7 days.");
    expect(planPrompt).toContain("Memory trust conflicts detected for this stage:");
    expect(planPrompt).toContain("Resolve contradictory memory items");
    expect(persistence.artifacts["memory-conflict-stage_plan_1"]).toBeDefined();
    expect(persistence.artifacts["memory-conflict-latest"]).toBeDefined();
  });

  it("keeps conflicting memory candidates in monitor mode and records conflict metadata", async () => {
    const monitorConflictMemu = {
      async readContext() {
        return {
          items: [
            {
              id: "mem-a",
              title: "policy:shipping",
              content: "Shipping SLA is 2 business days.",
              relevance: 0.9,
              trust: {
                source: "kb",
                confidence: 0.91,
                lastValidatedAt: "2026-04-05T00:00:00.000Z"
              }
            },
            {
              id: "mem-b",
              title: "policy:shipping",
              content: "Shipping SLA is 5 business days.",
              relevance: 0.89,
              trust: {
                source: "note",
                confidence: 0.9,
                lastValidatedAt: "2026-04-01T00:00:00.000Z"
              }
            }
          ],
          compressedPrompt: "compressed should be bypassed on conflict"
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

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          confidence: 0.9,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu: monitorConflictMemu,
      tracer,
      persistence
    });

    const result = await runner.runWorkflow(request, {
      ...workflow,
      memoryPolicy: {
        retrievalMode: "monitor",
        maxContextItems: 4,
        writebackEnabled: true,
        piiRetention: "redacted"
      }
    });

    expect(result.status).toBe("completed");
    const planPrompt = persistence.stagePrompts.find((record) => record.stage === "plan")?.prompt ?? "";
    expect(planPrompt).toContain("Shipping SLA is 2 business days.");
    expect(planPrompt).toContain("Shipping SLA is 5 business days.");
    const conflict = JSON.parse(persistence.artifacts["memory-conflict-stage_plan_1"] ?? "{}") as {
      droppedMemoryIds?: string[];
    };
    expect(conflict.droppedMemoryIds).toEqual([]);
  });

  it("drops stale reason-mode memory conflicts and keeps items with invalid validation timestamps", async () => {
    const staleConflictMemu = {
      async readContext() {
        return {
          items: [
            {
              id: "mem-preferred",
              title: "policy:refund",
              content: "Refund window is 30 days.",
              relevance: 0.95,
              trust: {
                source: "kb",
                confidence: 0.9,
                lastValidatedAt: "2026-04-05T00:00:00.000Z"
              }
            },
            {
              id: "mem-stale",
              title: "policy:refund",
              content: "Refund window is 21 days.",
              relevance: 0.9,
              trust: {
                source: "legacy",
                confidence: 0.9,
                lastValidatedAt: "2025-01-01T00:00:00.000Z"
              }
            },
            {
              id: "mem-invalid-date",
              title: "policy:refund",
              content: "Refund window is 14 days.",
              relevance: 0.85,
              trust: {
                source: "chat",
                confidence: 0.9,
                lastValidatedAt: "not-a-date"
              }
            },
            {
              id: "mem-missing-date",
              title: "policy:refund",
              content: "Refund window is 10 days.",
              relevance: 0.84,
              trust: {
                source: "chat",
                confidence: 0.9
              }
            }
          ]
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

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          confidence: 0.9,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu: staleConflictMemu,
      tracer,
      persistence
    });

    const result = await runner.runWorkflow(request, {
      ...workflow,
      memoryPolicy: {
        retrievalMode: "reason",
        maxContextItems: 6,
        writebackEnabled: true,
        piiRetention: "redacted"
      }
    });

    expect(result.status).toBe("completed");
    const planPrompt = persistence.stagePrompts.find((record) => record.stage === "plan")?.prompt ?? "";
    expect(planPrompt).toContain("Refund window is 30 days.");
    expect(planPrompt).toContain("Refund window is 14 days.");
    expect(planPrompt).toContain("Refund window is 10 days.");
    expect(planPrompt).not.toContain("Refund window is 21 days.");
    const conflict = JSON.parse(persistence.artifacts["memory-conflict-stage_plan_1"] ?? "{}") as {
      droppedMemoryIds?: string[];
    };
    expect(conflict.droppedMemoryIds).toContain("mem-stale");
    expect(conflict.droppedMemoryIds).not.toContain("mem-invalid-date");
    expect(conflict.droppedMemoryIds).not.toContain("mem-missing-date");
  });

  it("does not emit memory conflict artifacts when duplicate entries have matching content", async () => {
    const duplicateContentMemu = {
      async readContext() {
        return {
          items: [
            {
              id: "mem-1",
              title: "policy:sla",
              content: "SLA is 99.9%.",
              relevance: 0.8
            },
            {
              id: "mem-2",
              title: "policy:sla",
              content: "SLA is 99.9%.",
              relevance: 0.7
            }
          ]
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

    const model: ModelProvider = {
      async generate({ stage }) {
        return {
          output: stage === "verify" ? "PASS" : "ok",
          confidence: 0.9,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu: duplicateContentMemu,
      tracer,
      persistence
    });

    const result = await runner.runWorkflow(request, {
      ...workflow,
      memoryPolicy: {
        retrievalMode: "reason",
        maxContextItems: 4,
        writebackEnabled: true,
        piiRetention: "redacted"
      }
    });

    expect(result.status).toBe("completed");
    expect(Object.keys(persistence.artifacts).some((name) => name.startsWith("memory-conflict-"))).toBe(false);
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

  it("clamps out-of-range confidence values to 0..1", async () => {
    const model: ModelProvider = {
      async generate({ stage }) {
        if (stage === "plan") {
          return {
            output: "ok",
            confidence: -0.4,
            latencyMs: 1
          };
        }

        if (stage === "execute") {
          return {
            output: "ok",
            confidence: 1.4,
            latencyMs: 1
          };
        }

        return {
          output: "PASS",
          confidence: Number.NaN,
          latencyMs: 1
        };
      }
    };

    const persistence = new CapturePersistence();
    const runner = createWorkflowRunner({
      model,
      memu,
      tracer,
      persistence,
      confidenceGatePolicy: {
        threshold: 0.6,
        stages: []
      }
    });

    const result = await runner.runWorkflow(request, workflow);

    expect(result.status).toBe("completed");
    expect(persistence.stageRecords.find((record) => record.stage === "plan")?.confidence).toBe(0);
    expect(persistence.stageRecords.find((record) => record.stage === "execute")?.confidence).toBe(1);
    expect(persistence.stageRecords.find((record) => record.stage === "verify")?.confidence).toBe(0);
  });
});
