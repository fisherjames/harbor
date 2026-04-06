import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  adversarialNightlyScheduled,
  functions,
  inngest,
  resolveStuckRunRecoveryPolicies,
  runStuckRunRecoveryScan,
  stuckRunRecoveryScheduled,
  runNightlyAdversarialScan,
  workflowRunRequested
} from "../src/index.js";
import { DEFAULT_HARBOR_POLICY_DOCUMENT, createWorkflowPolicyBundle } from "@harbor/engine";
import type { RunStore, StuckRunCandidate } from "@harbor/database";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("worker exports", () => {
  it("exports inngest client and functions array", () => {
    expect(inngest).toBeDefined();
    expect(Array.isArray(functions)).toBe(true);
    expect(functions.length).toBeGreaterThan(2);
  });

  it("runs workflow handler", async () => {
    const policyBundle = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT);

    const result = await workflowRunRequested.fn({
      event: {
        data: {
          request: {
            tenantId: "t1",
            workspaceId: "w1",
            workflowId: "wf_1",
            trigger: "manual",
            input: {
              prompt: "hello"
            },
            actorId: "u1"
          },
          workflow: {
            id: "wf_1",
            name: "Demo",
            version: 1,
            objective: "obj",
            systemPrompt: "sys",
            policyBundle,
            memoryPolicy: {
              retrievalMode: "monitor",
              maxContextItems: 4,
              writebackEnabled: true,
              piiRetention: "redacted"
            },
            nodes: [
              { id: "plan", type: "planner", owner: "ops", timeoutMs: 50, retryLimit: 0 },
              { id: "execute", type: "executor", owner: "ops", timeoutMs: 50, retryLimit: 0 },
              { id: "verify", type: "verifier", owner: "ops", timeoutMs: 50, retryLimit: 0 }
            ]
          }
        }
      }
    });

    expect(result.status).toBe("completed");
  });

  it("initializes with managed memu branch when endpoint is set", async () => {
    vi.stubEnv("MEMU_ENDPOINT", "https://memu.example");
    const module = await import("../src/inngest.js");

    expect(module.inngest).toBeDefined();
    expect(module.functions.length).toBeGreaterThan(0);
  });

  it("passes optional memu credentials when configured", async () => {
    vi.stubEnv("MEMU_ENDPOINT", "https://memu.example");
    vi.stubEnv("MEMU_API_KEY", "k1");
    vi.stubEnv("MEMU_SIGNING_SECRET", "s1");

    const module = await import("../src/inngest.js");
    expect(module.workflowRunRequested).toBeDefined();
  });

  it("initializes with policy signing configuration branch", async () => {
    vi.stubEnv("HARBOR_POLICY_SIGNING_SECRET", "policy-secret");
    vi.stubEnv("HARBOR_TRUSTED_POLICY_SIGNATURES", "sig-a,sig-b");

    const module = await import("../src/inngest.js");
    expect(module.workflowRunRequested).toBeDefined();
  });

  it("initializes with policy signing secret only", async () => {
    vi.stubEnv("HARBOR_POLICY_SIGNING_SECRET", "policy-secret");

    const module = await import("../src/inngest.js");
    expect(module.workflowRunRequested).toBeDefined();
  });

  it("initializes with postgres run persistence branch when DATABASE_URL is set", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://harbor:harbor@localhost:5432/harbor");
    const module = await import("../src/inngest.js");

    expect(module.inngest).toBeDefined();
    expect(module.functions.length).toBeGreaterThan(0);
  });

  it("initializes with openai model provider configuration", async () => {
    vi.stubEnv("HARBOR_MODEL_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("HARBOR_OPENAI_MODEL", "gpt-4.1-mini");
    const module = await import("../src/inngest.js");

    expect(module.workflowRunRequested).toBeDefined();
  });

  it("produces nightly adversarial report taxonomy", () => {
    const policyBundle = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT);
    const report = runNightlyAdversarialScan([
      {
        tenantId: "tenant_1",
        workspaceId: "workspace_1",
        workflow: {
          id: "wf_safe",
          name: "Safe",
          version: 1,
          objective: "Use tenant-scoped context",
          systemPrompt: "Enforce tenant boundary and workspace boundary.",
          policyBundle,
          memoryPolicy: {
            retrievalMode: "reason",
            maxContextItems: 16,
            writebackEnabled: true,
            piiRetention: "redacted"
          },
          nodes: [
            { id: "plan", type: "planner", owner: "ops", timeoutMs: 50, retryLimit: 0 },
            { id: "execute", type: "executor", owner: "ops", timeoutMs: 50, retryLimit: 0 },
            { id: "verify", type: "verifier", owner: "ops", timeoutMs: 50, retryLimit: 0 }
          ]
        }
      },
      {
        tenantId: "tenant_1",
        workspaceId: "workspace_1",
        workflow: {
          id: "wf_warning",
          name: "Warning",
          version: 2,
          objective: "Use tenant-scoped context",
          systemPrompt: "Enforce tenant boundary and workspace boundary.",
          policyBundle,
          memoryPolicy: {
            retrievalMode: "reason",
            maxContextItems: 16,
            writebackEnabled: true,
            piiRetention: "allowed"
          },
          nodes: [
            { id: "plan", type: "planner", owner: "ops", timeoutMs: 50, retryLimit: 0 },
            { id: "execute", type: "executor", owner: "ops", timeoutMs: 50, retryLimit: 0 },
            { id: "verify", type: "verifier", owner: "ops", timeoutMs: 50, retryLimit: 0 }
          ]
        }
      }
    ]);

    expect(report.mode).toBe("nightly");
    expect(report.workflowCount).toBe(2);
    expect(report.blockedWorkflowCount).toBe(0);
    expect(report.taxonomy.totalFindings).toBeGreaterThan(0);
    expect(report.taxonomy.byCategory.memory_poisoning).toBeGreaterThan(0);
  });

  it("runs scheduled nightly adversarial function", async () => {
    const result = await adversarialNightlyScheduled.fn({});
    expect(result.mode).toBe("nightly");
    expect(result.suiteId).toBe("adversarial-nightly-report-v1");
  });

  it("recovers stuck runs using escalation and recovery artifacts", async () => {
    const candidates: StuckRunCandidate[] = [
      {
        runId: "run_stale_1",
        tenantId: "tenant_1",
        workspaceId: "workspace_1",
        workflowId: "wf_1",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z"
      },
      {
        runId: "run_stale_2",
        tenantId: "tenant_1",
        workspaceId: "workspace_1",
        workflowId: "wf_2",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:11:00.000Z"
      }
    ];
    const escalatedRuns: string[] = [];
    const artifactWrites: Array<{ runId: string; name: string }> = [];
    const deadLetteredRuns: string[] = [];

    const fakeStore = {
      listStuckRuns: vi.fn(async () => candidates),
      escalateRun: vi.fn(async (_scope, input) => {
        if (input.runId === "run_stale_1") {
          escalatedRuns.push(input.runId);
          return {
            runId: input.runId,
            status: "needs_human" as const,
            updatedAt: "2026-01-01T01:00:00.000Z"
          };
        }

        return null;
      }),
      updateStatus: vi.fn(async (runId: string, status: string) => {
        if (status === "failed") {
          deadLetteredRuns.push(runId);
        }
      }),
      storeArtifact: vi.fn(async (runId: string, name: string) => {
        artifactWrites.push({ runId, name });
      })
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 600,
      limit: 10
    });

    expect(report.detectorId).toBe("stuck-run-recovery-v1");
    expect(report.scanned).toBe(2);
    expect(report.recovered).toBe(1);
    expect(report.deadLettered).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]?.status).toBe("recovered");
    expect(report.runs[1]?.status).toBe("dead_letter");
    expect(escalatedRuns).toEqual(["run_stale_1"]);
    expect(deadLetteredRuns).toEqual(["run_stale_2"]);
    expect(artifactWrites).toEqual([
      { runId: "run_stale_1", name: "stuck-run-recovery" },
      { runId: "run_stale_2", name: "stuck-run-dead-letter" }
    ]);
  });

  it("runs scheduled stuck-run recovery function", async () => {
    const result = await stuckRunRecoveryScheduled.fn({});
    expect(result.detectorId).toBe("stuck-run-recovery-v1");
    expect(typeof result.scanned).toBe("number");
  });

  it("uses parsed scheduled env overrides for stuck-run recovery thresholds", async () => {
    vi.stubEnv("HARBOR_STUCK_RUN_STALE_AFTER_SECONDS", "1200");
    vi.stubEnv("HARBOR_STUCK_RUN_SCAN_LIMIT", "7");

    const result = await stuckRunRecoveryScheduled.fn({});
    expect(result.staleAfterSeconds).toBe(1200);
  });

  it("falls back to defaults when scheduled env thresholds are invalid", async () => {
    vi.stubEnv("HARBOR_STUCK_RUN_STALE_AFTER_SECONDS", "not-a-number");
    vi.stubEnv("HARBOR_STUCK_RUN_SCAN_LIMIT", "0");

    const result = await stuckRunRecoveryScheduled.fn({});
    expect(result.staleAfterSeconds).toBe(900);
  });

  it("uses default stuck-run scan thresholds when input overrides are omitted", async () => {
    const listStuckRuns = vi.fn(async () => [] as StuckRunCandidate[]);
    const fakeStore = {
      listStuckRuns,
      escalateRun: vi.fn(async () => null),
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore);

    expect(listStuckRuns).toHaveBeenCalledWith({
      staleAfterSeconds: 900,
      limit: 100
    });
    expect(report.scanned).toBe(0);
    expect(report.recovered).toBe(0);
    expect(report.deadLettered).toBe(0);
  });

  it("applies scope policies and skips runs when policy disables recovery", async () => {
    const staleCandidates: StuckRunCandidate[] = [
      {
        runId: "run_scope_1",
        tenantId: "tenant_1",
        workspaceId: "workspace_a",
        workflowId: "wf_a",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        runId: "run_scope_2",
        tenantId: "tenant_1",
        workspaceId: "workspace_b",
        workflowId: "wf_b",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];
    const escalated: string[] = [];

    const fakeStore = {
      listStuckRuns: vi.fn(async () => staleCandidates),
      escalateRun: vi.fn(async (_scope, input) => {
        escalated.push(input.runId);
        return {
          runId: input.runId,
          status: "needs_human" as const,
          updatedAt: "2026-01-01T01:00:00.000Z"
        };
      }),
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 60,
      limit: 10,
      policies: [
        {
          tenantId: "tenant_1",
          workspaceId: "workspace_a",
          staleAfterSeconds: 60,
          limit: 1,
          enabled: true
        },
        {
          tenantId: "tenant_1",
          workspaceId: "workspace_b",
          staleAfterSeconds: 60,
          limit: 1,
          enabled: false
        }
      ]
    });

    expect(report.recovered).toBe(1);
    expect(report.deadLettered).toBe(0);
    expect(report.skipped).toBe(1);
    expect(escalated).toEqual(["run_scope_1"]);
    expect(report.runs.find((run) => run.runId === "run_scope_2")?.status).toBe("skipped");
  });

  it("skips candidates that are below the scope stale threshold", async () => {
    const candidate: StuckRunCandidate = {
      runId: "run_too_fresh",
      tenantId: "tenant_1",
      workspaceId: "workspace_1",
      workflowId: "wf_1",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: new Date().toISOString()
    };
    const escalateRun = vi.fn(async () => null);
    const fakeStore = {
      listStuckRuns: vi.fn(async () => [candidate]),
      escalateRun,
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 60,
      limit: 10,
      policies: [
        {
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          staleAfterSeconds: 3600,
          limit: 10,
          enabled: true
        }
      ]
    });

    expect(escalateRun).not.toHaveBeenCalled();
    expect(report.recovered).toBe(0);
    expect(report.deadLettered).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.runs[0]?.reason).toContain("below scope stale threshold");
  });

  it("enforces scope recovery limit after first successful recovery", async () => {
    const oldTimestamp = "2026-01-01T00:00:00.000Z";
    const fakeStore = {
      listStuckRuns: vi.fn(async () => [
        {
          runId: "run_limit_1",
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          workflowId: "wf_1",
          status: "running" as const,
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp
        },
        {
          runId: "run_limit_2",
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          workflowId: "wf_1",
          status: "running" as const,
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp
        }
      ]),
      escalateRun: vi.fn(async (_scope, input) => ({
        runId: input.runId,
        status: "needs_human" as const,
        updatedAt: "2026-01-01T01:00:00.000Z"
      })),
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 60,
      limit: 10,
      policies: [
        {
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          staleAfterSeconds: 60,
          limit: 1,
          enabled: true
        }
      ]
    });

    expect(report.recovered).toBe(1);
    expect(report.deadLettered).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.runs.find((run) => run.runId === "run_limit_2")?.reason).toContain("Scope recovery limit reached");
  });

  it("treats invalid updatedAt timestamps as stale during recovery evaluation", async () => {
    const escalateRun = vi.fn(async (_scope, input) => ({
      runId: input.runId,
      status: "needs_human" as const,
      updatedAt: "2026-01-01T01:00:00.000Z"
    }));
    const fakeStore = {
      listStuckRuns: vi.fn(async () => [
        {
          runId: "run_invalid_updated_at",
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          workflowId: "wf_invalid",
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "not-a-date"
        }
      ]),
      escalateRun,
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 120,
      limit: 5
    });

    expect(escalateRun).toHaveBeenCalledTimes(1);
    expect(report.recovered).toBe(1);
    expect(report.deadLettered).toBe(0);
  });

  it("falls back to default policy when configured scope policy does not match tenant/workspace", async () => {
    const escalateRun = vi.fn(async (_scope, input) => ({
      runId: input.runId,
      status: "needs_human" as const,
      updatedAt: "2026-01-01T01:00:00.000Z"
    }));
    const fakeStore = {
      listStuckRuns: vi.fn(async () => [
        {
          runId: "run_policy_fallback",
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          workflowId: "wf_1",
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]),
      escalateRun,
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 60,
      limit: 5,
      policies: [
        {
          tenantId: "tenant_other",
          workspaceId: "workspace_other",
          staleAfterSeconds: 300,
          limit: 1,
          enabled: false
        }
      ]
    });

    expect(escalateRun).toHaveBeenCalledTimes(1);
    expect(report.recovered).toBe(1);
    expect(report.skipped).toBe(0);
  });

  it("supports wildcard scope policies for matched candidate recovery", async () => {
    const escalateRun = vi.fn(async (_scope, input) => ({
      runId: input.runId,
      status: "needs_human" as const,
      updatedAt: "2026-01-01T01:00:00.000Z"
    }));
    const fakeStore = {
      listStuckRuns: vi.fn(async () => [
        {
          runId: "run_wildcard_policy",
          tenantId: "tenant_x",
          workspaceId: "workspace_y",
          workflowId: "wf_wildcard",
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]),
      escalateRun,
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 60,
      limit: 5,
      policies: [
        {
          tenantId: "*",
          workspaceId: "*",
          staleAfterSeconds: 30,
          limit: 5,
          enabled: true
        }
      ]
    });

    expect(escalateRun).toHaveBeenCalledTimes(1);
    expect(report.recovered).toBe(1);
  });

  it("dead-letters runs when escalation throws and records escalation error context", async () => {
    const fakeStore = {
      listStuckRuns: vi.fn(async () => [
        {
          runId: "run_escalation_throw",
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          workflowId: "wf_1",
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]),
      escalateRun: vi.fn(async () => {
        throw new Error("escalation transport failure");
      }),
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 60,
      limit: 5
    });

    expect(report.recovered).toBe(0);
    expect(report.deadLettered).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.runs[0]?.status).toBe("dead_letter");
  });

  it("handles non-Error escalation failures and still dead-letters candidate", async () => {
    const fakeStore = {
      listStuckRuns: vi.fn(async () => [
        {
          runId: "run_non_error_throw",
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          workflowId: "wf_1",
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]),
      escalateRun: vi.fn(async () => {
        throw "transport failure";
      }),
      updateStatus: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 60,
      limit: 5
    });

    expect(report.deadLettered).toBe(1);
    expect(report.runs[0]?.status).toBe("dead_letter");
  });

  it("marks candidate as skipped when dead-letter persistence fails", async () => {
    const fakeStore = {
      listStuckRuns: vi.fn(async () => [
        {
          runId: "run_dead_letter_failure",
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          workflowId: "wf_2",
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]),
      escalateRun: vi.fn(async () => null),
      updateStatus: vi.fn(async () => {
        throw new Error("missing run");
      }),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "updateStatus" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 60,
      limit: 5
    });

    expect(report.recovered).toBe(0);
    expect(report.deadLettered).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.runs[0]?.status).toBe("skipped");
    expect(report.runs[0]?.reason).toContain("Dead-letter fallback failed");
  });

  it("parses scoped stuck-run policies from JSON env payload", () => {
    const policies = resolveStuckRunRecoveryPolicies(
      JSON.stringify([
        null,
        42,
        {
          tenantId: "tenant_1",
          workspaceId: "workspace_1",
          staleAfterSeconds: 120,
          limit: 12,
          enabled: true
        },
        {
          tenantId: "*",
          workspaceId: "*",
          staleAfterSeconds: 900,
          limit: 100
        }
      ])
    );

    expect(policies).toHaveLength(2);
    expect(policies[0]).toMatchObject({
      tenantId: "tenant_1",
      workspaceId: "workspace_1",
      staleAfterSeconds: 120,
      limit: 12,
      enabled: true
    });
    expect(policies[1]).toMatchObject({
      tenantId: "*",
      workspaceId: "*",
      staleAfterSeconds: 900,
      limit: 100,
      enabled: true
    });

    const invalid = resolveStuckRunRecoveryPolicies("{not-json");
    expect(invalid).toEqual([]);

    const nonArray = resolveStuckRunRecoveryPolicies(JSON.stringify({ tenantId: "tenant_1" }));
    expect(nonArray).toEqual([]);

    const fallbackValues = resolveStuckRunRecoveryPolicies(
      JSON.stringify([
        {
          tenantId: 42,
          workspaceId: null,
          staleAfterSeconds: "bad",
          limit: null
        },
        {
          tenantId: "",
          workspaceId: "",
          staleAfterSeconds: -1,
          limit: 0
        }
      ]),
      {
        staleAfterSeconds: 77,
        limit: 55
      }
    );
    expect(fallbackValues[0]).toMatchObject({
      tenantId: "*",
      workspaceId: "*",
      staleAfterSeconds: 77,
      limit: 55
    });
    expect(fallbackValues[1]).toMatchObject({
      tenantId: "*",
      workspaceId: "*",
      staleAfterSeconds: 77,
      limit: 55
    });
  });

  it("defaults nightly fixtures to empty when file payload omits fixtures array", () => {
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const targetPath = String(args[0]);
      if (targetPath.endsWith("docs/adversarial/workflows/nightly-fixtures.json")) {
        return "{}" as unknown as ReturnType<typeof fs.readFileSync>;
      }

      return originalReadFileSync(...(args as Parameters<typeof fs.readFileSync>));
    });

    try {
      const report = runNightlyAdversarialScan();
      expect(report.workflowCount).toBe(0);
      expect(report.taxonomy.totalFindings).toBe(0);
    } finally {
      readFileSpy.mockRestore();
    }
  });
});
