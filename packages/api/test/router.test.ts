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
});
