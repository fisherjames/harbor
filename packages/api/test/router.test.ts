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
    async createPromotionPullRequest(_context, input) {
      return {
        repository: "owner/repo",
        baseBranch: input.baseBranch ?? "main",
        headBranch: input.headBranch ?? `harbor/promotion/${input.workflowId}-v${input.version}`,
        artifactPath: `harbor/workflows/${input.workflowId}/v${input.version}.json`,
        status: "created",
        summary: "Promotion pull request created.",
        pullRequestNumber: 11,
        pullRequestUrl: "https://github.com/owner/repo/pull/11"
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
    expect(result.evalGate.calibration.rubricVersion).toBe("rubric-v0");
    expect(result.promotionGate.status).toBe("passed");
    expect(result.adversarialGate.status).toBe("passed");
    expect(result.shadowGate.status).toBe("passed");
    expect(result.shadowGate.mode).toBe("active");
    expect(result.bridge.target).toBe("deploy");
    expect(result.bridge.nextAction).toBe("deploy_workflow");
    expect(result.bridge.steps.map((step) => step.stepId)).toEqual([
      "lint",
      "eval",
      "promotion",
      "adversarial",
      "shadow"
    ]);
  });

  it("records default shadow comparison metadata for canary rollout mode", async () => {
    const router = createRouter();
    const caller = router.createCaller(scopedContext);

    const result = await caller.deployWorkflow({
      workflowId: workflow.id,
      expectedVersion: 1,
      workflow: {
        ...workflow,
        rolloutMode: "canary"
      }
    });

    expect(result.blocked).toBe(false);
    expect(result.shadowGate.mode).toBe("canary");
    expect(result.shadowGate.status).toBe("passed");
    expect(result.shadowGate.comparison?.artifactPath).toContain(`/shadow/${workflow.id}/v${workflow.version}/deploy.json`);
  });

  it("rejects deploy when policy verification fails", async () => {
    const router = createRouter({
      policyVerifier: {
        verify() {
          return {
            valid: false,
            reasons: ["Policy signature is not trusted."]
          };
        }
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(
      caller.deployWorkflow({
        workflowId: workflow.id,
        expectedVersion: workflow.version,
        workflow
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED"
    });
  });

  it("returns policy metadata on deploy when verifier passes", async () => {
    const router = createRouter({
      policyVerifier: {
        verify() {
          return {
            valid: true,
            reasons: [],
            policyVersion: "policy-v1",
            signature: "b".repeat(64)
          };
        }
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.deployWorkflow({
      workflowId: workflow.id,
      expectedVersion: workflow.version,
      workflow
    });

    expect(result.policyVersion).toBe("policy-v1");
    expect(result.policySignature).toBe("b".repeat(64));
  });

  it("skips eval and promotion gates when deploy lint is critical", async () => {
    const evalCalls: string[] = [];
    const promotionCalls: string[] = [];
    const shadowCalls: string[] = [];
    const router = createRouter({
      async runEvalGate(_context, input) {
        evalCalls.push(input.event);
        return {
          suiteId: "eval-smoke",
          status: "passed",
          blocked: false,
          score: 1,
          summary: "ok",
          failingScenarios: [],
          calibration: {
            rubricVersion: "rubric-v1",
            benchmarkSetId: "shared-benchmark-v1",
            calibratedAt: "2026-04-06T00:00:00.000Z",
            agreementScore: 1,
            driftScore: 0,
            minimumAgreement: 0.85,
            maximumDrift: 0.15,
            driftDetected: false
          }
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
      },
      async runShadowGate(_context, input) {
        shadowCalls.push(input.event);
        return {
          mode: input.rolloutMode,
          status: "passed",
          blocked: false,
          summary: "ok"
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
    expect(result.adversarialGate.status).toBe("skipped");
    expect(result.shadowGate.status).toBe("skipped");
    expect(result.bridge.blocked).toBe(true);
    expect(result.bridge.nextAction).toBe("halt_and_remediate");
    expect(result.bridge.steps[0]?.status).toBe("failed");
    expect(evalCalls).toEqual([]);
    expect(promotionCalls).toEqual([]);
    expect(shadowCalls).toEqual([]);
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
          failingScenarios: ["planner_regression"],
          calibration: {
            rubricVersion: "rubric-v1",
            benchmarkSetId: "shared-benchmark-v1",
            calibratedAt: "2026-04-06T00:00:00.000Z",
            agreementScore: 0.4,
            driftScore: 0.6,
            minimumAgreement: 0.85,
            maximumDrift: 0.15,
            driftDetected: true
          }
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
    expect(result.evalGate.calibration.driftDetected).toBe(true);
    expect(result.adversarialGate.status).toBe("passed");
    expect(result.shadowGate.status).toBe("skipped");
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
    expect(result.adversarialGate.status).toBe("passed");
    expect(result.shadowGate.status).toBe("skipped");
  });

  it("blocks deploy when adversarial gate fails", async () => {
    const router = createRouter({
      async runAdversarialGate() {
        return {
          suiteId: "adversarial-smoke",
          status: "failed",
          blocked: true,
          summary: "Prompt injection exploit remained effective.",
          findings: [
            {
              findingId: "adv_1",
              scenarioId: "prompt_injection_override",
              category: "prompt_injection",
              severity: "critical",
              summary: "User-controlled instructions overrode system constraints.",
              resolutionSteps: [
                "Append an explicit instruction hierarchy section to constraints.",
                "Require verifier-stage confirmation that user content cannot relax tool policy."
              ]
            }
          ],
          taxonomy: {
            totalFindings: 1,
            criticalFindings: 1,
            warningFindings: 0,
            byCategory: {
              prompt_injection: 1,
              tool_permission_escalation: 0,
              cross_tenant_access: 0,
              memory_poisoning: 0
            },
            byScenario: {
              prompt_injection_override: 1
            }
          }
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
    expect(result.blockedReasons).toContain("adversarial");
    expect(result.adversarialGate.status).toBe("failed");
    expect(result.shadowGate.status).toBe("skipped");
    expect(result.adversarialGate.findings).toHaveLength(1);
    expect(result.adversarialGate.taxonomy.totalFindings).toBe(1);
    expect(result.adversarialGate.findings[0]?.resolutionSteps[0]).toContain("instruction hierarchy");
  });

  it("blocks deploy when shadow gate fails", async () => {
    const router = createRouter({
      async runShadowGate(inputContext, input) {
        return {
          mode: input.rolloutMode,
          status: "failed",
          blocked: true,
          summary: `Shadow parity failed for ${input.event} in ${inputContext.workspaceId}.`,
          comparison: {
            baselineRunId: "baseline:wf_1:v1:deploy",
            candidateRunId: "candidate:wf_1:v1:deploy",
            parityScore: 0.72,
            divergenceCount: 4,
            artifactPath: "harbor/shadow/wf_1/v1/deploy.json"
          }
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.deployWorkflow({
      workflowId: workflow.id,
      expectedVersion: workflow.version,
      workflow: {
        ...workflow,
        rolloutMode: "shadow"
      }
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toContain("shadow");
    expect(result.shadowGate.status).toBe("failed");
    expect(result.shadowGate.comparison?.divergenceCount).toBe(4);
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
    expect(result.adversarialGate.status).toBe("skipped");
    expect(result.shadowGate.status).toBe("skipped");
    expect(publishCalls).toHaveLength(0);
  });

  it("returns policy metadata when publish is blocked and verifier passes", async () => {
    const router = createRouter({
      policyVerifier: {
        verify() {
          return {
            valid: true,
            reasons: [],
            policyVersion: "policy-v1",
            signature: "f".repeat(64)
          };
        }
      },
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
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.publishWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.blocked).toBe(true);
    expect(result.policyVersion).toBe("policy-v1");
    expect(result.policySignature).toBe("f".repeat(64));
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
          failingScenarios: ["verify_budget"],
          calibration: {
            rubricVersion: "rubric-v1",
            benchmarkSetId: "shared-benchmark-v1",
            calibratedAt: "2026-04-06T00:00:00.000Z",
            agreementScore: 0.5,
            driftScore: 0.5,
            minimumAgreement: 0.85,
            maximumDrift: 0.15,
            driftDetected: true
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
    expect(result.blockedReasons).toContain("eval");
    expect(result.evalGate.status).toBe("failed");
    expect(result.adversarialGate.status).toBe("passed");
    expect(result.shadowGate.status).toBe("skipped");
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
    expect(result.adversarialGate.status).toBe("passed");
    expect(result.shadowGate.status).toBe("skipped");
    expect(publishCalls).toHaveLength(0);
  });

  it("blocks publish when adversarial gate fails before publish mutation", async () => {
    const publishCalls: string[] = [];
    const router = createRouter({
      async runAdversarialGate() {
        return {
          suiteId: "adversarial-smoke",
          status: "failed",
          blocked: true,
          summary: "Cross-tenant access attempt was not denied.",
          findings: [
            {
              findingId: "adv_2",
              scenarioId: "cross_tenant_access_probe",
              category: "cross_tenant_access",
              severity: "critical",
              summary: "Tenant scope bypass was observed in adversarial simulation.",
              resolutionSteps: [
                "Enforce tenant/workspace predicates in every router branch.",
                "Add verifier check that run artifacts never include foreign tenant IDs."
              ]
            }
          ],
          taxonomy: {
            totalFindings: 1,
            criticalFindings: 1,
            warningFindings: 0,
            byCategory: {
              prompt_injection: 0,
              tool_permission_escalation: 0,
              cross_tenant_access: 1,
              memory_poisoning: 0
            },
            byScenario: {
              cross_tenant_access_probe: 1
            }
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
    expect(result.blockedReasons).toContain("adversarial");
    expect(result.adversarialGate.status).toBe("failed");
    expect(result.shadowGate.status).toBe("skipped");
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
    expect(published.evalGate.calibration.rubricVersion).toBe("rubric-v0");
    expect(published.promotionGate.status).toBe("passed");
    expect(published.adversarialGate.status).toBe("passed");
    expect(published.shadowGate.status).toBe("passed");
    expect(published.blockedReasons).toEqual([]);
    expect(published.bridge.target).toBe("publish");
    expect(published.bridge.nextAction).toBe("publish_workflow");
  });

  it("records publish shadow comparison metadata for canary rollout mode", async () => {
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
            rolloutMode: "canary"
          }
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const published = await caller.publishWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(published.blocked).toBe(false);
    expect(published.shadowGate.mode).toBe("canary");
    expect(published.shadowGate.status).toBe("passed");
    expect(published.shadowGate.summary).toContain("publish baseline");
    expect(published.shadowGate.comparison?.artifactPath).toContain(`/shadow/${workflow.id}/v${workflow.version}/publish.json`);
  });

  it("returns policy metadata when publishing with verifier", async () => {
    const router = createRouter({
      policyVerifier: {
        verify() {
          return {
            valid: true,
            reasons: [],
            policyVersion: "policy-v1",
            signature: "c".repeat(64)
          };
        }
      }
    });
    const caller = router.createCaller(scopedContext);

    const published = await caller.publishWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(published.policyVersion).toBe("policy-v1");
    expect(published.policySignature).toBe("c".repeat(64));
  });

  it("returns not found when opening promotion pull request for unknown version", async () => {
    const router = createRouter({
      async getWorkflowVersion() {
        return null;
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(
      caller.openPromotionPullRequest({
        workflowId: workflow.id,
        version: workflow.version
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("skips opening promotion pull request when lint is critical", async () => {
    const promotionCalls: Array<{ workflowId: string; version: number }> = [];
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
      async createPromotionPullRequest(_context, input) {
        promotionCalls.push({
          workflowId: input.workflowId,
          version: input.version
        });
        return {
          repository: "owner/repo",
          baseBranch: "main",
          headBranch: "harbor/promotion/blocked",
          artifactPath: "harbor/workflows/wf_1/v1.json",
          status: "created",
          summary: "should not run"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.openPromotionPullRequest({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toEqual(["lint"]);
    expect(result.evalGate.status).toBe("skipped");
    expect(result.promotionGate.status).toBe("skipped");
    expect(result.adversarialGate.status).toBe("skipped");
    expect(result.shadowGate.status).toBe("skipped");
    expect(result.promotion.status).toBe("skipped");
    expect(result.promotion.baseBranch).toBe("main");
    expect(result.promotion.headBranch).toContain("harbor/promotion/");
    expect(promotionCalls).toHaveLength(0);
  });

  it("returns policy metadata when promotion is blocked and verifier passes", async () => {
    const router = createRouter({
      policyVerifier: {
        verify() {
          return {
            valid: true,
            reasons: [],
            policyVersion: "policy-v1",
            signature: "1".repeat(64)
          };
        }
      },
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
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.openPromotionPullRequest({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.blocked).toBe(true);
    expect(result.policyVersion).toBe("policy-v1");
    expect(result.policySignature).toBe("1".repeat(64));
  });

  it("skips opening promotion pull request when eval gate fails and preserves branch overrides", async () => {
    const promotionCalls: string[] = [];
    const router = createRouter({
      async runEvalGate() {
        return {
          suiteId: "eval-smoke",
          status: "failed",
          blocked: true,
          score: 0.25,
          summary: "Regression detected",
          failingScenarios: ["executor_quality"],
          calibration: {
            rubricVersion: "rubric-v1",
            benchmarkSetId: "shared-benchmark-v1",
            calibratedAt: "2026-04-06T00:00:00.000Z",
            agreementScore: 0.55,
            driftScore: 0.45,
            minimumAgreement: 0.85,
            maximumDrift: 0.15,
            driftDetected: true
          }
        };
      },
      async createPromotionPullRequest() {
        promotionCalls.push("called");
        return {
          repository: "owner/repo",
          baseBranch: "main",
          headBranch: "head",
          artifactPath: "path",
          status: "created",
          summary: "should not run"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.openPromotionPullRequest({
      workflowId: workflow.id,
      version: workflow.version,
      baseBranch: "release",
      headBranch: "harbor/promotion/custom"
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toContain("eval");
    expect(result.adversarialGate.status).toBe("passed");
    expect(result.shadowGate.status).toBe("skipped");
    expect(result.promotion.status).toBe("skipped");
    expect(result.promotion.baseBranch).toBe("release");
    expect(result.promotion.headBranch).toBe("harbor/promotion/custom");
    expect(promotionCalls).toHaveLength(0);
  });

  it("skips opening promotion pull request when adversarial gate fails", async () => {
    const promotionCalls: string[] = [];
    const router = createRouter({
      async runAdversarialGate() {
        return {
          suiteId: "adversarial-smoke",
          status: "failed",
          blocked: true,
          summary: "Tool permission escalation test failed.",
          findings: [
            {
              findingId: "adv_3",
              scenarioId: "tool_permission_scope_escape",
              category: "tool_permission_escalation",
              severity: "critical",
              summary: "Tool call executed outside declared permission scope.",
              resolutionSteps: [
                "Restrict tool permissions to explicit allow-list at deploy time.",
                "Require verifier-stage assertion of expected tool call set."
              ]
            }
          ],
          taxonomy: {
            totalFindings: 1,
            criticalFindings: 1,
            warningFindings: 0,
            byCategory: {
              prompt_injection: 0,
              tool_permission_escalation: 1,
              cross_tenant_access: 0,
              memory_poisoning: 0
            },
            byScenario: {
              tool_permission_scope_escape: 1
            }
          }
        };
      },
      async createPromotionPullRequest() {
        promotionCalls.push("called");
        return {
          repository: "owner/repo",
          baseBranch: "main",
          headBranch: "head",
          artifactPath: "path",
          status: "created",
          summary: "should not run"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.openPromotionPullRequest({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toContain("adversarial");
    expect(result.adversarialGate.status).toBe("failed");
    expect(result.shadowGate.status).toBe("skipped");
    expect(result.promotion.status).toBe("skipped");
    expect(promotionCalls).toHaveLength(0);
  });

  it("skips opening promotion pull request when shadow gate fails", async () => {
    const promotionCalls: string[] = [];
    const router = createRouter({
      async runShadowGate(_context, input) {
        return {
          mode: input.rolloutMode,
          status: "failed",
          blocked: true,
          summary: "Shadow replay diverged from baseline.",
          comparison: {
            baselineRunId: "baseline:wf_1:v1:publish",
            candidateRunId: "candidate:wf_1:v1:publish",
            parityScore: 0.64,
            divergenceCount: 5,
            artifactPath: "harbor/shadow/wf_1/v1/publish.json"
          }
        };
      },
      async getWorkflowVersion() {
        return {
          workflowId: "wf_1",
          version: 1,
          state: "draft",
          savedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          savedBy: "user_1",
          workflow: {
            ...workflow,
            rolloutMode: "shadow"
          }
        };
      },
      async createPromotionPullRequest() {
        promotionCalls.push("called");
        return {
          repository: "owner/repo",
          baseBranch: "main",
          headBranch: "head",
          artifactPath: "path",
          status: "created",
          summary: "should not run"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.openPromotionPullRequest({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toContain("shadow");
    expect(result.shadowGate.status).toBe("failed");
    expect(result.promotion.status).toBe("skipped");
    expect(promotionCalls).toHaveLength(0);
  });

  it("opens promotion pull request when gates pass", async () => {
    const calls: Array<{
      workflowId: string;
      version: number;
      baseBranch?: string | undefined;
      headBranch?: string | undefined;
    }> = [];
    const router = createRouter({
      async createPromotionPullRequest(_context, input) {
        calls.push({
          workflowId: input.workflowId,
          version: input.version,
          baseBranch: input.baseBranch,
          headBranch: input.headBranch
        });
        return {
          repository: "owner/repo",
          baseBranch: input.baseBranch ?? "main",
          headBranch: input.headBranch ?? "harbor/promotion/default",
          artifactPath: `harbor/workflows/${input.workflowId}/v${input.version}.json`,
          status: "created",
          summary: "Promotion pull request created.",
          pullRequestNumber: 77,
          pullRequestUrl: "https://github.com/owner/repo/pull/77"
        };
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.openPromotionPullRequest({
      workflowId: workflow.id,
      version: workflow.version,
      baseBranch: "release",
      headBranch: "harbor/promotion/wf_1-v1"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workflowId: workflow.id,
      version: workflow.version,
      baseBranch: "release",
      headBranch: "harbor/promotion/wf_1-v1"
    });
    expect(result.blocked).toBe(false);
    expect(result.blockedReasons).toEqual([]);
    expect(result.adversarialGate.status).toBe("passed");
    expect(result.shadowGate.status).toBe("passed");
    expect(result.bridge.target).toBe("promotion");
    expect(result.bridge.nextAction).toBe("open_promotion_pull_request");
    expect(result.promotion.status).toBe("created");
    expect(result.promotion.pullRequestNumber).toBe(77);
    expect(result.promotion.pullRequestUrl).toContain("/pull/77");
  });

  it("returns policy metadata when opening promotion pull request with verifier", async () => {
    const router = createRouter({
      policyVerifier: {
        verify() {
          return {
            valid: true,
            reasons: [],
            policyVersion: "policy-v1",
            signature: "d".repeat(64)
          };
        }
      }
    });
    const caller = router.createCaller(scopedContext);

    const result = await caller.openPromotionPullRequest({
      workflowId: workflow.id,
      version: workflow.version
    });

    expect(result.policyVersion).toBe("policy-v1");
    expect(result.policySignature).toBe("d".repeat(64));
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
      policyVerifier: {
        verify() {
          return {
            valid: true,
            reasons: [],
            policyVersion: "policy-v1",
            signature: "e".repeat(64)
          };
        }
      },
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

  it("rejects runWorkflow when policy verification fails", async () => {
    const router = createRouter({
      policyVerifier: {
        verify() {
          return {
            valid: false,
            reasons: ["Workflow is missing policyBundle."]
          };
        }
      }
    });
    const caller = router.createCaller(scopedContext);

    await expect(
      caller.runWorkflow({
        workflow,
        trigger: "manual",
        input: {
          prompt: "hello"
        }
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED"
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
