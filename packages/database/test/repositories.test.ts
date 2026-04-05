import { describe, expect, it } from "vitest";
import {
  assertTenantScope,
  InMemoryWorkflowRegistry,
  InMemoryRunPersistence,
  PostgresRunPersistence,
  createPostgresRunPersistence
} from "../src/index.js";
import { tokenUsageFromStages } from "../src/repositories/run-store.js";
import type { WorkflowRunRequest } from "@harbor/engine";

const workflow = {
  id: "wf_1",
  name: "Demo",
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
    {
      id: "plan",
      type: "planner",
      owner: "ops",
      timeoutMs: 100,
      retryLimit: 1
    },
    {
      id: "verify",
      type: "verifier",
      owner: "ops",
      timeoutMs: 100,
      retryLimit: 1
    }
  ]
} as const;

const request: WorkflowRunRequest = {
  tenantId: "t",
  workspaceId: "w",
  workflowId: workflow.id,
  trigger: "manual",
  input: {},
  actorId: "u"
};

describe("tenant scope assertions", () => {
  it("accepts valid scope", () => {
    expect(() => assertTenantScope({ tenantId: "t", workspaceId: "w" })).not.toThrow();
  });

  it("rejects empty tenant or workspace", () => {
    expect(() => assertTenantScope({ tenantId: "", workspaceId: "w" })).toThrow("tenantId");
    expect(() => assertTenantScope({ tenantId: "t", workspaceId: "" })).toThrow("workspaceId");
  });
});

describe("InMemoryRunPersistence", () => {
  it("stores run lifecycle state and serves run detail", async () => {
    const persistence = new InMemoryRunPersistence();
    const runId = await persistence.createRun(request, workflow);

    await persistence.updateStatus(runId, "running", { started: true });
    await persistence.addLintFindings(runId, []);
    await persistence.appendStage(runId, {
      stage: "plan",
      startedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      completedAt: new Date("2026-01-01T00:00:01.000Z").toISOString(),
      prompt: "p",
      output: "o",
      attempts: 1,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      },
      lintFindings: []
    });
    await persistence.storeArtifact(runId, "result", "done");

    const snapshot = persistence.getSnapshot(runId);
    expect(snapshot.status).toBe("running");
    expect(snapshot.details).toEqual({ started: true });
    expect(snapshot.stages).toHaveLength(1);
    expect(snapshot.artifacts.result).toBe("done");

    const detail = await persistence.getRun({ tenantId: "t", workspaceId: "w" }, runId);
    expect(detail?.runId).toBe(runId);
    expect(detail?.tokenUsage.totalTokens).toBe(15);
    expect(detail?.tokenUsage.estimatedCostUsd).toBe(0.00015);
  });

  it("filters list by scope/workflow/status and supports escalation", async () => {
    const persistence = new InMemoryRunPersistence();
    const runId = await persistence.createRun(request, workflow);
    await persistence.createRun(
      {
        ...request,
        tenantId: "other",
        workspaceId: "other"
      },
      workflow
    );

    await persistence.updateStatus(runId, "completed");
    const list = await persistence.listRuns(
      { tenantId: "t", workspaceId: "w" },
      {
        status: "completed",
        workflowId: workflow.id,
        limit: 10
      }
    );
    expect(list).toHaveLength(1);
    const defaultLimited = await persistence.listRuns({ tenantId: "t", workspaceId: "w" });
    expect(defaultLimited.length).toBeGreaterThan(0);

    const escalation = await persistence.escalateRun(
      { tenantId: "t", workspaceId: "w" },
      {
        runId,
        actorId: "operator",
        reason: "Need manual review"
      }
    );
    expect(escalation?.status).toBe("needs_human");

    const denied = await persistence.escalateRun(
      { tenantId: "bad", workspaceId: "bad" },
      {
        runId,
        actorId: "operator",
        reason: "no access"
      }
    );
    expect(denied).toBeNull();

    const missing = await persistence.escalateRun(
      { tenantId: "t", workspaceId: "w" },
      {
        runId: "missing",
        actorId: "operator",
        reason: "none"
      }
    );
    expect(missing).toBeNull();

    const hidden = await persistence.getRun({ tenantId: "bad", workspaceId: "bad" }, runId);
    expect(hidden).toBeNull();
  });

  it("throws for unknown run id on mutation methods", async () => {
    const persistence = new InMemoryRunPersistence();
    await expect(persistence.updateStatus("missing", "running")).rejects.toThrow("Unknown runId");
    await expect(persistence.getRun({ tenantId: "t", workspaceId: "w" }, "missing")).resolves.toBeNull();
  });
});

class FakeDb {
  public calls: Array<{ text: string; values?: unknown[] }> = [];
  private readonly queue: Array<{ rows: unknown[]; rowCount: number }>;

  constructor(queue: Array<{ rows: unknown[]; rowCount: number }>) {
    this.queue = [...queue];
  }

  async query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ text, values });
    const next = this.queue.shift() ?? { rows: [], rowCount: 1 };
    return {
      rows: next.rows as Row[],
      rowCount: next.rowCount
    };
  }
}

describe("PostgresRunPersistence", () => {
  it("creates runs, persists stage/artifact/lint data, and lists runs", async () => {
    const db = new FakeDb([
      { rows: [], rowCount: 1 }, // createRun insert
      { rows: [], rowCount: 1 }, // appendStage insert
      { rows: [], rowCount: 1 }, // appendStage touch execution updated_at
      { rows: [], rowCount: 1 }, // storeArtifact insert
      { rows: [], rowCount: 1 }, // storeArtifact touch updated_at
      { rows: [], rowCount: 1 }, // addLintFindings -> storeArtifact insert
      { rows: [], rowCount: 1 }, // addLintFindings -> touch updated_at
      {
        rows: [
          {
            id: "run_1",
            workflow_id: "wf_1",
            status: "completed",
            trigger: "manual",
            actor_id: "u",
            input: {},
            output: {},
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:01:00.000Z"
          }
        ],
        rowCount: 1
      }, // list runs
      {
        rows: [
          {
            stage: "plan",
            prompt: "p",
            output: "o",
            attempts: 1,
            token_usage: {
              inputTokens: 20,
              outputTokens: 10,
              totalTokens: 30
            },
            started_at: "2026-01-01T00:00:00.000Z",
            completed_at: "2026-01-01T00:00:01.000Z"
          }
        ],
        rowCount: 1
      } // stage usage lookup for list
    ]);

    const persistence = new PostgresRunPersistence(db);
    const runId = await persistence.createRun(request, workflow);
    expect(runId.startsWith("run_")).toBe(true);

    await persistence.appendStage(runId, {
      stage: "plan",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      prompt: "p",
      output: "o",
      attempts: 1,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      },
      lintFindings: []
    });
    await persistence.storeArtifact(runId, "result", "done");
    await persistence.addLintFindings(runId, []);

    const list = await persistence.listRuns(
      { tenantId: "t", workspaceId: "w" },
      {
        status: "completed",
        workflowId: "wf_1",
        limit: 20
      }
    );
    expect(list[0]?.runId).toBe("run_1");
    expect(list[0]?.tokenUsage.totalTokens).toBe(30);
    expect(db.calls.some((call) => call.text.includes("FROM executions"))).toBe(true);
  });

  it("updates status with details and appends stages without token usage", async () => {
    const db = new FakeDb([
      { rows: [], rowCount: 1 }, // update status
      { rows: [], rowCount: 1 }, // append stage insert
      { rows: [], rowCount: 1 } // append stage touch updated_at
    ]);

    const persistence = new PostgresRunPersistence(db);
    await persistence.updateStatus("run_1", "running", { started: true });
    await persistence.appendStage("run_1", {
      stage: "verify",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      prompt: "verify",
      output: "PASS",
      attempts: 1,
      lintFindings: []
    });

    expect(db.calls.length).toBe(3);
  });

  it("gets run details, handles JSON parsing variants, and escalates runs", async () => {
    const db = new FakeDb([
      {
        rows: [
          {
            id: "run_1",
            workflow_id: "wf_1",
            status: "running",
            trigger: "manual",
            actor_id: "u",
            input: "{\"prompt\":\"hello\"}",
            output: { partial: true },
            created_at: new Date("2026-01-01T00:00:00.000Z"),
            updated_at: new Date("2026-01-01T00:00:30.000Z")
          }
        ],
        rowCount: 1
      }, // getRun execution
      {
        rows: [
          {
            stage: "plan",
            prompt: "p",
            output: "o",
            attempts: 1,
            token_usage: "{\"inputTokens\":10,\"outputTokens\":5,\"totalTokens\":15}",
            started_at: "2026-01-01T00:00:00.000Z",
            completed_at: "2026-01-01T00:00:01.000Z"
          }
        ],
        rowCount: 1
      }, // getRun stages
      {
        rows: [
          { name: "__lint-findings", value: "[]" },
          { name: "result", value: "done" }
        ],
        rowCount: 2
      }, // getRun artifacts
      { rows: [], rowCount: 1 }, // escalate update
      { rows: [], rowCount: 1 }, // audit insert
      { rows: [], rowCount: 1 }, // manual-escalation artifact insert
      { rows: [], rowCount: 1 } // touch updated_at from storeArtifact
    ]);

    const persistence = new PostgresRunPersistence(db);
    const detail = await persistence.getRun({ tenantId: "t", workspaceId: "w" }, "run_1");
    expect(detail?.input.prompt).toBe("hello");
    expect(detail?.tokenUsage.totalTokens).toBe(15);
    expect(detail?.artifacts.result).toBe("done");

    const escalation = await persistence.escalateRun(
      { tenantId: "t", workspaceId: "w" },
      { runId: "run_1", actorId: "operator", reason: "Need review" }
    );
    expect(escalation?.status).toBe("needs_human");
  });

  it("handles missing JSON/token/lint fields while reading run details", async () => {
    const db = new FakeDb([
      {
        rows: [
          {
            id: "run_2",
            workflow_id: "wf_1",
            status: "running",
            trigger: "manual",
            actor_id: "u",
            input: { prompt: "hello" },
            output: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:30.000Z"
          }
        ],
        rowCount: 1
      }, // getRun execution
      {
        rows: [
          {
            stage: "plan",
            prompt: "p",
            output: "o",
            attempts: 1,
            token_usage: null,
            started_at: "2026-01-01T00:00:00.000Z",
            completed_at: "2026-01-01T00:00:01.000Z"
          }
        ],
        rowCount: 1
      }, // getRun stages without token usage
      {
        rows: [{ name: "result", value: "done" }],
        rowCount: 1
      } // artifacts without lint findings
    ]);

    const persistence = new PostgresRunPersistence(db);
    const detail = await persistence.getRun({ tenantId: "t", workspaceId: "w" }, "run_2");

    expect(detail?.output).toBeUndefined();
    expect(detail?.lintFindings).toEqual([]);
    expect(detail?.tokenUsage.totalTokens).toBe(0);
  });

  it("lists runs when stage token usage is absent and uses default limit", async () => {
    const db = new FakeDb([
      {
        rows: [
          {
            id: "run_3",
            workflow_id: "wf_1",
            status: "completed",
            trigger: "manual",
            actor_id: "u",
            input: {},
            output: {},
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:01:00.000Z"
          }
        ],
        rowCount: 1
      }, // list runs
      {
        rows: [
          {
            stage: "plan",
            prompt: "p",
            output: "o",
            attempts: 1,
            token_usage: null,
            started_at: "2026-01-01T00:00:00.000Z",
            completed_at: "2026-01-01T00:00:01.000Z"
          }
        ],
        rowCount: 1
      } // stage usage lookup
    ]);

    const persistence = new PostgresRunPersistence(db);
    const list = await persistence.listRuns({ tenantId: "t", workspaceId: "w" });
    expect(list[0]?.tokenUsage.totalTokens).toBe(0);
  });

  it("uses empty object fallback when execution input payload is absent", async () => {
    const db = new FakeDb([
      {
        rows: [
          {
            id: "run_4",
            workflow_id: "wf_1",
            status: "running",
            trigger: "manual",
            actor_id: "u",
            input: null,
            output: "{}",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:30.000Z"
          }
        ],
        rowCount: 1
      },
      { rows: [], rowCount: 0 }, // stages
      { rows: [], rowCount: 0 } // artifacts
    ]);

    const persistence = new PostgresRunPersistence(db);
    const detail = await persistence.getRun({ tenantId: "t", workspaceId: "w" }, "run_4");
    expect(detail?.input).toEqual({});
  });

  it("returns null when run is missing and throws unknown update status", async () => {
    const db = new FakeDb([
      { rows: [], rowCount: 0 }, // update status missing
      { rows: [], rowCount: 0 }, // getRun missing
      { rows: [], rowCount: 0 } // escalate missing
    ]);
    const persistence = new PostgresRunPersistence(db);

    await expect(persistence.updateStatus("missing", "running")).rejects.toThrow("Unknown runId");
    await expect(persistence.getRun({ tenantId: "t", workspaceId: "w" }, "missing")).resolves.toBeNull();
    await expect(
      persistence.escalateRun(
        { tenantId: "t", workspaceId: "w" },
        {
          runId: "missing",
          actorId: "operator",
          reason: "none"
        }
      )
    ).resolves.toBeNull();
  });

  it("validates postgres factory input and creates persistence instance", () => {
    expect(() => createPostgresRunPersistence("")).toThrow("DATABASE_URL is required");
    const persistence = createPostgresRunPersistence("postgres://harbor:harbor@localhost:5432/harbor");
    expect(persistence).toBeInstanceOf(PostgresRunPersistence);
  });

  it("computes token usage even when some stages do not include tokenUsage", () => {
    const usage = tokenUsageFromStages([
      {
        stage: "plan",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        prompt: "p",
        output: "o",
        attempts: 1,
        lintFindings: []
      },
      {
        stage: "execute",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        prompt: "p2",
        output: "o2",
        attempts: 1,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140
        },
        lintFindings: []
      }
    ]);

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(40);
    expect(usage.totalTokens).toBe(140);
  });
});

describe("InMemoryWorkflowRegistry", () => {
  const scope = {
    tenantId: "tenant_1",
    workspaceId: "workspace_1"
  };

  const alternateScope = {
    tenantId: "tenant_2",
    workspaceId: "workspace_2"
  };

  const workflowV1 = {
    ...workflow,
    id: "wf_registry",
    version: 1
  };

  const workflowV2 = {
    ...workflow,
    id: "wf_registry",
    version: 2
  };

  it("saves, lists, and gets versions in descending order", async () => {
    const registry = new InMemoryWorkflowRegistry();

    const savedV1 = await registry.saveVersion(scope, {
      workflow: workflowV1,
      actorId: "user_1"
    });
    const savedV2 = await registry.saveVersion(scope, {
      workflow: workflowV2,
      actorId: "user_2"
    });

    expect(savedV1.state).toBe("draft");
    expect(savedV2.state).toBe("draft");

    const versions = await registry.listVersions(scope, workflowV1.id);
    expect(versions.map((record) => record.version)).toEqual([2, 1]);

    const v1 = await registry.getVersion(scope, workflowV1.id, 1);
    expect(v1?.savedBy).toBe("user_1");
  });

  it("updates existing version records and preserves isolation by scope", async () => {
    const registry = new InMemoryWorkflowRegistry();

    await registry.saveVersion(scope, {
      workflow: workflowV1,
      actorId: "user_1"
    });
    await registry.saveVersion(alternateScope, {
      workflow: workflowV1,
      actorId: "other_user"
    });

    const updated = await registry.saveVersion(scope, {
      workflow: {
        ...workflowV1,
        name: "Updated Name"
      },
      actorId: "user_2",
      state: "published"
    });

    expect(updated.savedBy).toBe("user_2");
    expect(updated.state).toBe("published");
    expect(updated.workflow.name).toBe("Updated Name");

    const primary = await registry.getVersion(scope, workflowV1.id, 1);
    const isolated = await registry.getVersion(alternateScope, workflowV1.id, 1);
    expect(primary?.savedBy).toBe("user_2");
    expect(isolated?.savedBy).toBe("other_user");
  });

  it("publishes a target version and demotes others to draft", async () => {
    const registry = new InMemoryWorkflowRegistry();

    await registry.saveVersion(scope, {
      workflow: workflowV1,
      actorId: "user_1"
    });
    await registry.saveVersion(scope, {
      workflow: workflowV2,
      actorId: "user_2"
    });

    const published = await registry.publishVersion(scope, {
      workflowId: workflowV1.id,
      version: 2,
      actorId: "publisher"
    });

    expect(published?.state).toBe("published");
    expect(published?.savedBy).toBe("publisher");

    const versions = await registry.listVersions(scope, workflowV1.id);
    expect(versions.find((record) => record.version === 2)?.state).toBe("published");
    expect(versions.find((record) => record.version === 1)?.state).toBe("draft");
  });

  it("returns null/empty for missing state and missing versions", async () => {
    const registry = new InMemoryWorkflowRegistry();

    const missingList = await registry.listVersions(scope, "missing");
    const missingGet = await registry.getVersion(scope, "missing", 1);
    const missingPublishNoState = await registry.publishVersion(scope, {
      workflowId: "missing",
      version: 1,
      actorId: "u"
    });

    await registry.saveVersion(scope, {
      workflow: workflowV1,
      actorId: "user_1"
    });
    const missingPublishNoVersion = await registry.publishVersion(scope, {
      workflowId: workflowV1.id,
      version: 99,
      actorId: "u"
    });
    const missingGetVersion = await registry.getVersion(scope, workflowV1.id, 99);

    expect(missingList).toEqual([]);
    expect(missingGet).toBeNull();
    expect(missingPublishNoState).toBeNull();
    expect(missingPublishNoVersion).toBeNull();
    expect(missingGetVersion).toBeNull();
  });

  it("returns cloned records so callers cannot mutate stored state", async () => {
    const registry = new InMemoryWorkflowRegistry();

    const saved = await registry.saveVersion(scope, {
      workflow: workflowV1,
      actorId: "user_1"
    });
    saved.workflow.name = "Mutated by caller";
    saved.state = "published";

    const listed = await registry.listVersions(scope, workflowV1.id);
    expect(listed[0]?.workflow.name).toBe(workflowV1.name);
    expect(listed[0]?.state).toBe("draft");
  });
});
