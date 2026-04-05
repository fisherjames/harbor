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
