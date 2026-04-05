import { describe, expect, it } from "vitest";
import { createServerCallerWithContext } from "../src/server/caller";
import { getAppRouter, resetRouterForTests } from "../src/server/dependencies";
import { sampleWorkflow } from "../src/lib/sample-workflow";
import { createServerCaller } from "../src/server/caller";

describe("web server caller", () => {
  it("returns singleton app router", () => {
    resetRouterForTests();
    const a = getAppRouter();
    const b = getAppRouter();

    expect(a).toBe(b);
  });

  it("calls typed save and run procedures", async () => {
    resetRouterForTests();
    const caller = await createServerCallerWithContext({
      tenantId: "tenant",
      workspaceId: "workspace",
      actorId: "actor"
    });

    const save = await caller.saveWorkflow({ workflow: sampleWorkflow });
    expect(save.blocked).toBe(false);

    const run = await caller.runWorkflow({
      workflow: sampleWorkflow,
      trigger: "manual",
      input: {
        prompt: "hello"
      }
    });

    expect(run.status).toBe("completed");

    const runs = await caller.listRuns({
      limit: 10
    });
    expect(runs.length).toBeGreaterThan(0);

    const runDetail = await caller.getRun({
      runId: run.runId
    });
    expect(runDetail.runId).toBe(run.runId);

    const escalated = await caller.escalateRun({
      runId: run.runId,
      reason: "Operator requested review"
    });
    expect(escalated.status).toBe("needs_human");

    const escalatedDefaultReason = await caller.escalateRun({
      runId: run.runId
    });
    expect(escalatedDefaultReason.status).toBe("needs_human");
  });

  it("creates caller from headers", async () => {
    resetRouterForTests();
    const caller = await createServerCaller({
      headers: new Headers({
        "x-harbor-tenant-id": "tenant",
        "x-harbor-workspace-id": "workspace",
        "x-harbor-actor-id": "actor"
      }),
      authProvider: async () => ({ userId: null, orgId: null })
    });

    const result = await caller.saveWorkflow({ workflow: sampleWorkflow });
    expect(result.workflowId).toBe(sampleWorkflow.id);
  });
});
