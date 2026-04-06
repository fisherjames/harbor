import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  adversarialNightlyScheduled,
  functions,
  inngest,
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
      storeArtifact: vi.fn(async (runId: string, name: string) => {
        artifactWrites.push({ runId, name });
      })
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore, {
      staleAfterSeconds: 600,
      limit: 10
    });

    expect(report.detectorId).toBe("stuck-run-recovery-v1");
    expect(report.scanned).toBe(2);
    expect(report.recovered).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]?.status).toBe("recovered");
    expect(report.runs[1]?.status).toBe("skipped");
    expect(escalatedRuns).toEqual(["run_stale_1"]);
    expect(artifactWrites).toEqual([{ runId: "run_stale_1", name: "stuck-run-recovery" }]);
  });

  it("runs scheduled stuck-run recovery function", async () => {
    const result = await stuckRunRecoveryScheduled.fn({});
    expect(result.detectorId).toBe("stuck-run-recovery-v1");
    expect(typeof result.scanned).toBe("number");
  });

  it("uses default stuck-run scan thresholds when input overrides are omitted", async () => {
    const listStuckRuns = vi.fn(async () => [] as StuckRunCandidate[]);
    const fakeStore = {
      listStuckRuns,
      escalateRun: vi.fn(async () => null),
      storeArtifact: vi.fn(async () => undefined)
    } satisfies Pick<RunStore, "listStuckRuns" | "escalateRun" | "storeArtifact">;

    const report = await runStuckRunRecoveryScan(fakeStore as RunStore);

    expect(listStuckRuns).toHaveBeenCalledWith({
      staleAfterSeconds: 900,
      limit: 100
    });
    expect(report.scanned).toBe(0);
    expect(report.recovered).toBe(0);
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
