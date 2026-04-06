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
  systemPrompt:
    "You must follow harness constraints, only use approved capabilities, and return PASS or FAIL verification.",
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
      describe() {
        return {
          provider: "test-model",
          model: "test-v1"
        };
      },
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
      tracer,
      standardsRemediationProvider: {
        async load() {
          return {
            sourcePath: "docs/team-standards/reports/remediation.json",
            promptSection:
              "## Harness Resolution Steps\nApply these steps without changing the primary objective:\n1. Resolve repeated trend findings."
          };
        }
      }
    });

    const result = await runner.runWorkflow(baseRequest, {
      ...passingWorkflow,
      nodes: [
        { id: "plan", type: "planner", timeoutMs: 500 },
        { id: "execute", type: "executor", owner: "ops", timeoutMs: 500 },
        { id: "verify", type: "verifier", owner: "ops", timeoutMs: 500 }
      ]
    });

    expect(result.status).toBe("completed");
    expect(persistence.stages.some((stage) => stage.prompt.includes("## Harness Resolution Steps"))).toBe(true);
    expect(persistence.stages.some((stage) => stage.prompt.includes("Resolve repeated trend findings."))).toBe(true);
    expect(persistence.stages.some((stage) => stage.prompt.includes("## Prompt Envelope"))).toBe(true);
    expect(persistence.artifacts["prompt-envelope-hash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(persistence.artifacts["harness-policy-hash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(persistence.artifacts["standards-remediation-hash"]).toMatch(/^[a-f0-9]{64}$/);
    const policySnapshot = JSON.parse(persistence.artifacts["harness-policy-snapshot"] ?? "{}") as {
      nodeBudgets?: Array<{ nodeId: string; owner: string | null }>;
    };
    expect(policySnapshot.nodeBudgets?.find((node) => node.nodeId === "plan")?.owner).toBeNull();
    expect(persistence.artifacts["standards-remediation-source"]).toContain("remediation.json");
    expect(persistence.artifacts["standards-remediation-prompt-section"]).toContain("Resolve repeated trend findings.");
    const replayManifest = JSON.parse(persistence.artifacts["replay-bundle-manifest"] ?? "{}") as {
      modelSettings?: { provider?: string };
      stagePromptHashes?: Array<{ stage: string; hash: string }>;
    };
    expect(replayManifest.modelSettings?.provider).toBe("test-model");
    expect(replayManifest.stagePromptHashes?.length).toBeGreaterThan(0);
    expect(persistence.artifacts["replay-divergence-taxonomy"]).toContain("\"prompt\":0");
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

  it("applies prompt envelope policy overrides", async () => {
    const stagePrompts: Array<{ stage: string; prompt: string }> = [];

    const persistence: RunPersistence = {
      async createRun() {
        return "run_prompt_envelope";
      },
      async updateStatus() {
        return;
      },
      async addLintFindings() {
        return;
      },
      async appendStage(_runId, record) {
        stagePrompts.push({ stage: record.stage, prompt: record.prompt });
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

    const runner = createWorkflowRunner({
      model,
      memu,
      persistence,
      tracer,
      promptEnvelopePolicy: {
        platformSystemPrompt: "Platform policy: enforce tenancy isolation",
        workflowSystemPrompt: "Workflow policy: must stay bounded and deterministic",
        stageDirectives: {
          plan: "Plan with exactly two actionable steps."
        }
      }
    });

    const result = await runner.runWorkflow(baseRequest, passingWorkflow);

    expect(result.status).toBe("completed");
    const planPrompt = stagePrompts.find((record) => record.stage === "plan")?.prompt ?? "";
    expect(planPrompt).toContain("Platform policy: enforce tenancy isolation");
    expect(planPrompt).toContain("Workflow policy: must stay bounded and deterministic");
    expect(planPrompt).toContain("Plan with exactly two actionable steps.");
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

  it("fails early when policy verifier rejects workflow", async () => {
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
      tracer,
      policyVerifier: {
        verify() {
          return {
            valid: false,
            reasons: ["Workflow is missing policyBundle."],
            policyVersion: "policy-v1",
            signature: "a".repeat(64)
          };
        }
      }
    });

    const result = await runner.runWorkflow(baseRequest, passingWorkflow);

    expect(result.status).toBe("failed");
    expect(result.finalOutput?.reason).toBe("invalid_policy_bundle");
    expect(persistence.stages).toHaveLength(0);
    expect(persistence.artifacts["policy-version"]).toBe("policy-v1");
    expect(persistence.artifacts["policy-signature"]).toBe("a".repeat(64));
    expect(persistence.artifacts["replay-bundle-manifest"]).toContain("\"runId\":\"run_1\"");
  });
});
