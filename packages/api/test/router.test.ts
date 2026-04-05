import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { createHarborRouter, type HarborApiDependencies } from "../src/index.js";
import type { WorkflowRunRequest } from "@harbor/engine";

const workflow = {
  id: "wf_1",
  name: "Demo workflow",
  version: 1,
  objective: "Solve task",
  systemPrompt: "You are Harbor",
  memoryPolicy: {
    retrievalMode: "monitor",
    maxContextItems: 6,
    writebackEnabled: true,
    piiRetention: "redacted"
  },
  nodes: [
    {
      id: "plan",
      type: "planner",
      owner: "ops",
      timeoutMs: 1_000,
      retryLimit: 1
    },
    {
      id: "execute",
      type: "executor",
      owner: "ops",
      timeoutMs: 1_000,
      retryLimit: 1
    },
    {
      id: "verify",
      type: "verifier",
      owner: "ops",
      timeoutMs: 1_000,
      retryLimit: 1
    }
  ]
} as const;

function createRouter(overrides?: Partial<HarborApiDependencies>) {
  const deps: HarborApiDependencies = {
    async runWorkflow(request: WorkflowRunRequest) {
      return {
        runId: `run-${request.workflowId}`,
        status: "completed",
        finalOutput: {
          ok: true
        }
      };
    },
    async listRuns() {
      return [
        {
          runId: "run_1",
          workflowId: "wf_1",
          status: "completed",
          trigger: "manual",
          actorId: "user_1",
          createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          updatedAt: new Date("2026-01-01T00:01:00.000Z").toISOString(),
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            estimatedCostUsd: 0.00015
          }
        }
      ];
    },
    async getRun() {
      return {
        runId: "run_1",
        workflowId: "wf_1",
        status: "completed",
        trigger: "manual",
        actorId: "user_1",
        createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-01-01T00:01:00.000Z").toISOString(),
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          estimatedCostUsd: 0.00015
        },
        input: { prompt: "hello" },
        output: { ok: true },
        details: { ok: true },
        lintFindings: [],
        stages: [],
        artifacts: {}
      };
    },
    async escalateRun(_context, input) {
      return {
        runId: input.runId,
        status: "needs_human",
        updatedAt: new Date("2026-01-01T00:02:00.000Z").toISOString()
      };
    },
    async saveWorkflowVersion(_context, input) {
      return {
        workflowId: input.workflow.id,
        version: input.workflow.version,
        state: input.state,
        savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        savedBy: "user_1"
      };
    },
    async listWorkflowVersions() {
      return [
        {
          workflowId: "wf_1",
          version: 1,
          state: "draft",
          savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          savedBy: "user_1"
        }
      ];
    },
    async getWorkflowVersion() {
      return {
        workflowId: "wf_1",
        version: 1,
        state: "draft",
        savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        savedBy: "user_1",
        workflow
      };
    },
    async publishWorkflowVersion() {
      return {
        workflowId: "wf_1",
        version: 1,
        state: "published",
        savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        savedBy: "user_1"
      };
    },
    ...overrides
  };

  return createHarborRouter(deps);
}

const scopedContext = {
  tenantId: "tenant_1",
  workspaceId: "workspace_1",
  actorId: "user_1"
};

describe("createHarborRouter", () => {
  it("rejects missing tenancy scope", async () => {
    const router = createRouter();
    const caller = router.createCaller({ tenantId: "", workspaceId: "", actorId: "" });

    await expect(caller.saveWorkflow({ workflow })).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });
  });

  it("returns lint findings on save", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const result = await caller.saveWorkflow({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.filter((node) => node.type !== "verifier")
      }
    });

    expect(result.blocked).toBe(true);
    expect(result.lintFindings.some((finding) => finding.ruleId === "HAR001")).toBe(true);
  });

  it("saves workflow versions and defaults state to draft", async () => {
    const calls: Array<{ state: "draft" | "published" }> = [];
    const router = createRouter({
      async saveWorkflowVersion(_context, input) {
        calls.push({ state: input.state });
        return {
          workflowId: input.workflow.id,
          version: input.workflow.version,
          state: input.state,
          savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          savedBy: "user_1"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.saveWorkflowVersion({ workflow });

    expect(calls[0]?.state).toBe("draft");
    expect(result.workflowId).toBe(workflow.id);
    expect(result.state).toBe("draft");
    expect(result.blocked).toBe(false);
  });

  it("returns lint findings for saved workflow versions", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const result = await caller.saveWorkflowVersion({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.filter((node) => node.type !== "verifier")
      }
    });

    expect(result.blocked).toBe(true);
    expect(result.lintFindings.some((finding) => finding.ruleId === "HAR001")).toBe(true);
  });

  it("validates deploy version match", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    await expect(
      caller.deployWorkflow({
        workflowId: workflow.id,
        expectedVersion: 2,
        workflow
      })
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("validates deploy workflow id match", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    await expect(
      caller.deployWorkflow({
        workflowId: "different-id",
        expectedVersion: 1,
        workflow
      })
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("returns deploy metadata when valid", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const result = await caller.deployWorkflow({
      workflowId: workflow.id,
      expectedVersion: 1,
      workflow
    });

    expect(result.deploymentId).toContain("dep_");
    expect(result.blocked).toBe(false);
    expect(result.blockedReasons).toEqual([]);
    expect(result.evalGate.status).toBe("passed");
    expect(result.promotionGate.status).toBe("passed");
  });

  it("skips eval and promotion gates when deploy lint is critical", async () => {
    const evalCalls: string[] = [];
    const promotionCalls: string[] = [];
    const router = createRouter({
      async runEvalGate(_context, input) {
        evalCalls.push(input.event);
        return {
          suiteId: "eval-smoke",
          status: "passed",
          blocked: false,
          score: 1,
          summary: "ok",
          failingScenarios: []
        };
      },
      async runPromotionChecks(_context, input) {
        promotionCalls.push(input.event);
        return {
          provider: "github",
          repository: "owner/repo",
          branch: "main",
          status: "passed",
          blocked: false,
          checks: [
            {
              checkId: "github/checks",
              status: "passed",
              summary: "ok"
            }
          ]
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.deployWorkflow({
      workflowId: workflow.id,
      expectedVersion: workflow.version,
      workflow: {
        ...workflow,
        nodes: workflow.nodes.filter((node) => node.type !== "verifier")
      }
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toEqual(["lint"]);
    expect(result.evalGate.status).toBe("skipped");
    expect(result.promotionGate.status).toBe("skipped");
    expect(evalCalls).toEqual([]);
    expect(promotionCalls).toEqual([]);
  });

  it("blocks deploy when eval gate fails", async () => {
    const promotionCalls: string[] = [];
    const router = createRouter({
      async runEvalGate() {
        return {
          suiteId: "eval-smoke",
          status: "failed",
          blocked: true,
          score: 0.1,
          summary: "Regression detected",
          failingScenarios: ["planner_regression"]
        };
      },
      async runPromotionChecks(_context, input) {
        promotionCalls.push(input.event);
        return {
          provider: "github",
          repository: "owner/repo",
          branch: "main",
          status: "passed",
          blocked: false,
          checks: [
            {
              checkId: "github/checks",
              status: "passed",
              summary: "ok"
            }
          ]
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.deployWorkflow({
      workflowId: workflow.id,
      expectedVersion: workflow.version,
      workflow
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toContain("eval");
    expect(result.evalGate.status).toBe("failed");
    expect(promotionCalls).toEqual(["deploy"]);
  });

  it("blocks deploy when promotion checks fail", async () => {
    const router = createRouter({
      async runPromotionChecks() {
        return {
          provider: "github",
          repository: "owner/repo",
          branch: "main",
          status: "failed",
          blocked: true,
          checks: [
            {
              checkId: "github/checks",
              status: "failed",
              summary: "Required check failed"
            }
          ]
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.deployWorkflow({
      workflowId: workflow.id,
      expectedVersion: workflow.version,
      workflow
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toContain("promotion");
    expect(result.promotionGate.status).toBe("failed");
  });

  it("lists workflow versions", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const versions = await caller.listWorkflowVersions({
      workflowId: workflow.id
    });

    expect(versions).toHaveLength(1);
    expect(versions[0]?.workflowId).toBe(workflow.id);
  });

  it("gets a workflow version", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const version = await caller.getWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(version.workflowId).toBe(workflow.id);
    expect(version.version).toBe(workflow.version);
    expect(version.workflow.id).toBe(workflow.id);
  });

  it("returns not found when requested workflow version is missing", async () => {
    const router = createRouter({
      async getWorkflowVersion() {
        return null;
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(
      caller.getWorkflowVersion({
        workflowId: workflow.id,
        version: workflow.version
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("blocks publish when deploy lint is critical", async () => {
    const publishCalls: string[] = [];
    const router = createRouter({
      async getWorkflowVersion() {
        return {
          workflowId: "wf_1",
          version: 1,
          state: "draft",
          savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          savedBy: "user_1",
          workflow: {
            ...workflow,
            nodes: workflow.nodes.filter((node) => node.type !== "verifier")
          }
        };
      },
      async publishWorkflowVersion(_context, input) {
        publishCalls.push(`${input.workflowId}:${input.version}`);
        return {
          workflowId: input.workflowId,
          version: input.version,
          state: "published",
          savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          savedBy: "user_1"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.publishWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.blocked).toBe(true);
    expect(result.lintFindings.some((finding) => finding.ruleId === "HAR001")).toBe(true);
    expect(result.blockedReasons).toEqual(["lint"]);
    expect(result.evalGate.status).toBe("skipped");
    expect(result.promotionGate.status).toBe("skipped");
    expect(publishCalls).toHaveLength(0);
  });

  it("blocks publish when eval gate fails before publish mutation", async () => {
    const publishCalls: string[] = [];
    const router = createRouter({
      async runEvalGate() {
        return {
          suiteId: "eval-smoke",
          status: "failed",
          blocked: true,
          score: 0.2,
          summary: "Regression detected",
          failingScenarios: ["verify_budget"]
        };
      },
      async publishWorkflowVersion(_context, input) {
        publishCalls.push(`${input.workflowId}:${input.version}`);
        return {
          workflowId: input.workflowId,
          version: input.version,
          state: "published",
          savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          savedBy: "user_1"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.publishWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toContain("eval");
    expect(result.evalGate.status).toBe("failed");
    expect(publishCalls).toHaveLength(0);
  });

  it("blocks publish when promotion checks fail before publish mutation", async () => {
    const publishCalls: string[] = [];
    const router = createRouter({
      async runPromotionChecks() {
        return {
          provider: "github",
          repository: "owner/repo",
          branch: "main",
          status: "failed",
          blocked: true,
          checks: [
            {
              checkId: "github/pr-required",
              status: "failed",
              summary: "Check suite failed"
            }
          ]
        };
      },
      async publishWorkflowVersion(_context, input) {
        publishCalls.push(`${input.workflowId}:${input.version}`);
        return {
          workflowId: input.workflowId,
          version: input.version,
          state: "published",
          savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          savedBy: "user_1"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.publishWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toContain("promotion");
    expect(result.promotionGate.status).toBe("failed");
    expect(publishCalls).toHaveLength(0);
  });

  it("rejects publish for unknown version before lint", async () => {
    const router = createRouter({
      async getWorkflowVersion() {
        return null;
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(
      caller.publishWorkflowVersion({
        workflowId: workflow.id,
        version: workflow.version
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("rejects publish when dependency returns not found", async () => {
    const router = createRouter({
      async publishWorkflowVersion() {
        return null;
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(
      caller.publishWorkflowVersion({
        workflowId: workflow.id,
        version: workflow.version
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("publishes workflow version when lint passes", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const published = await caller.publishWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(published.workflowId).toBe(workflow.id);
    expect(published.version).toBe(workflow.version);
    expect(published.state).toBe("published");
    expect(published.blocked).toBe(false);
    expect(published.evalGate.status).toBe("passed");
    expect(published.promotionGate.status).toBe("passed");
    expect(published.blockedReasons).toEqual([]);
  });

  it("accepts typed tool policy fields in workflow input", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const toolWorkflow = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          id: "tool-node",
          type: "tool_call" as const,
          owner: "ops",
          timeoutMs: 500,
          retryLimit: 1,
          toolPermissionScope: ["search"],
          toolCallPolicy: {
            timeoutMs: 600,
            retryLimit: 1,
            maxCalls: 2
          }
        }
      ]
    };

    const save = await caller.saveWorkflowVersion({
      workflow: toolWorkflow
    });
    expect(save.blocked).toBe(false);
  });

  it("creates run request using scoped context", async () => {
    const calls: WorkflowRunRequest[] = [];

    const router = createRouter({
      async runWorkflow(request) {
        calls.push(request);
        return {
          runId: "run_1",
          status: "completed",
          finalOutput: {
            ok: true
          }
        };
      }
    });

    const caller = router.createCaller(scopedContext);

    await caller.runWorkflow({
      workflow,
      trigger: "manual",
      input: {
        prompt: "hello"
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tenantId: scopedContext.tenantId,
      workspaceId: scopedContext.workspaceId,
      actorId: scopedContext.actorId,
      workflowId: workflow.id,
      trigger: "manual"
    });
  });

  it("forwards optional idempotency key when provided", async () => {
    const calls: WorkflowRunRequest[] = [];

    const router = createRouter({
      async runWorkflow(request) {
        calls.push(request);
        return {
          runId: "run_idempotent",
          status: "completed"
        };
      }
    });

    const caller = router.createCaller(scopedContext);

    await caller.runWorkflow({
      workflow,
      trigger: "manual",
      input: {
        prompt: "hello"
      },
      idempotencyKey: "idem-1"
    });

    expect(calls[0]?.idempotencyKey).toBe("idem-1");
  });

  it("returns runs list scoped to tenant context", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const result = await caller.listRuns({
      limit: 10
    });

    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe("run_1");
  });

  it("returns run detail and handles not found", async () => {
    const router = createRouter({
      async getRun() {
        return null;
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(caller.getRun({ runId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("returns run detail when dependencies provide data", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const run = await caller.getRun({ runId: "run_1" });
    expect(run.runId).toBe("run_1");
    expect(run.tokenUsage.totalTokens).toBe(15);
  });

  it("escalates a run and applies default reason when omitted", async () => {
    const calls: Array<{ runId: string; reason?: string | undefined }> = [];
    const router = createRouter({
      async escalateRun(_context, input) {
        calls.push(input);
        return {
          runId: input.runId,
          status: "needs_human",
          updatedAt: new Date("2026-01-01T00:02:00.000Z").toISOString()
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.escalateRun({ runId: "run_1" });
    expect(result.status).toBe("needs_human");
    expect(calls[0]?.reason).toContain("Manual escalation requested");
  });

  it("rejects escalate if dependencies return non-escalated status", async () => {
    const router = createRouter({
      async escalateRun(_context, input) {
        return {
          runId: input.runId,
          status: "failed",
          updatedAt: new Date("2026-01-01T00:02:00.000Z").toISOString()
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(caller.escalateRun({ runId: "run_1", reason: "Need operator review" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR"
    });
  });

  it("rejects escalate with not found when dependencies return null", async () => {
    const router = createRouter({
      async escalateRun() {
        return null;
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(caller.escalateRun({ runId: "missing", reason: "none" })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });
});
