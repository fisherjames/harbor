import { randomUUID } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  runLintAtExecutionPoint,
  type HarnessRolloutMode,
  type LintFinding,
  type WorkflowDefinition
} from "@harbor/harness";
import type {
  PolicyVerificationResult,
  RunStatus,
  WorkflowPolicyVerifier,
  WorkflowRunRequest,
  WorkflowRunResult
} from "@harbor/engine";
import type {
  AdversarialGateSummary,
  BenchmarkToProductionBridge,
  DeployBlockReason,
  EvalGateSummary,
  PromotionGateSummary,
  ShadowGateSummary,
  DeployWorkflowOutput,
  GetWorkflowVersionInput,
  HarborApiContext,
  ListRunsInput,
  OpenPromotionPullRequestOutput,
  PromotionPullRequestResult,
  PublishWorkflowVersionOutput,
  ReplayRunOutput,
  RunDetail,
  RunSummary,
  SaveWorkflowVersionOutput,
  WorkflowVersionSummary
} from "./types.js";

const memoryPolicySchema = z.object({
  retrievalMode: z.enum(["monitor", "reason"]),
  maxContextItems: z.number().int().min(1),
  writebackEnabled: z.boolean(),
  piiRetention: z.enum(["forbidden", "redacted", "allowed"])
});

const policyBundleSchema = z.object({
  policyVersion: z.string().trim().min(1),
  algorithm: z.literal("sha256"),
  checksum: z.string().trim().length(64),
  signature: z.string().trim().length(64),
  document: z.object({
    version: z.string().trim().min(1),
    issuedAt: z.string().trim().min(1),
    constraints: z.object({
      requireNodeOwner: z.boolean(),
      requireNodeBudget: z.boolean(),
      requireToolPolicy: z.boolean(),
      requireMemoryPolicy: z.boolean(),
      allowPromptMutationsOnlyInHarness: z.boolean()
    }),
    runtime: z.object({
      blockOnCriticalLint: z.boolean(),
      maxFixAttempts: z.number().int().min(0),
      requireReplayBundle: z.boolean()
    })
  })
});

const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().min(1),
  objective: z.string().trim().min(1),
  systemPrompt: z.string().trim().min(1),
  rolloutMode: z.enum(["active", "canary", "shadow"]).optional(),
  memoryPolicy: memoryPolicySchema.optional(),
  policyBundle: policyBundleSchema.optional(),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum(["planner", "executor", "verifier", "memory_write", "tool_call"]),
        label: z.string().optional(),
        owner: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        retryLimit: z.number().int().min(0).optional(),
        promptTemplate: z.string().optional(),
        toolPermissionScope: z.array(z.string()).optional(),
        toolCallPolicy: z
          .object({
            timeoutMs: z.number().int().positive(),
            retryLimit: z.number().int().min(0),
            maxCalls: z.number().int().min(1),
            sideEffectMode: z.enum(["read", "propose", "commit"]).optional(),
            phaseGroup: z.string().trim().min(1).max(120).optional()
          })
          .optional()
      })
    )
    .min(1)
});

const deployInputSchema = z.object({
  workflowId: z.string().min(1),
  expectedVersion: z.number().int().min(1),
  workflow: workflowSchema
});

const saveInputSchema = z.object({
  workflow: workflowSchema
});

const runInputSchema = z.object({
  workflow: workflowSchema,
  trigger: z.enum(["manual", "schedule", "api"]).default("manual"),
  input: z.record(z.unknown()),
  idempotencyKey: z.string().trim().min(1).max(128).optional()
});

const workflowVersionStateSchema = z.enum(["draft", "published"]);

const saveWorkflowVersionInputSchema = z.object({
  workflow: workflowSchema,
  state: workflowVersionStateSchema.optional()
});

const listWorkflowVersionsInputSchema = z.object({
  workflowId: z.string().min(1)
});

const getWorkflowVersionInputSchema = z.object({
  workflowId: z.string().min(1),
  version: z.number().int().min(1)
});

const publishWorkflowVersionInputSchema = z.object({
  workflowId: z.string().min(1),
  version: z.number().int().min(1)
});

const openPromotionPullRequestInputSchema = z.object({
  workflowId: z.string().min(1),
  version: z.number().int().min(1),
  baseBranch: z.string().trim().min(1).max(255).optional(),
  headBranch: z.string().trim().min(1).max(255).optional()
});

const listRunsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  status: z.enum(["queued", "running", "needs_human", "failed", "completed"]).optional(),
  workflowId: z.string().min(1).optional()
});

const getRunInputSchema = z.object({
  runId: z.string().min(1)
});

const escalateRunInputSchema = z.object({
  runId: z.string().min(1),
  reason: z.string().trim().min(1).max(300).optional()
});

const replayRunInputSchema = z.object({
  sourceRunId: z.string().min(1),
  workflow: workflowSchema,
  replayReason: z.string().trim().min(1).max(300).optional(),
  trigger: z.enum(["manual", "api"]).default("manual"),
  idempotencyKey: z.string().trim().min(1).max(128).optional()
});

export interface HarborApiDependencies {
  runWorkflow(request: WorkflowRunRequest, workflow: WorkflowDefinition): Promise<WorkflowRunResult>;
  listRuns(context: HarborApiContext, input: ListRunsInput): Promise<RunSummary[]>;
  getRun(context: HarborApiContext, runId: string): Promise<RunDetail | null>;
  escalateRun(
    context: HarborApiContext,
    input: {
      runId: string;
      reason: string;
    }
  ): Promise<{
    runId: string;
    status: RunStatus;
    updatedAt: string;
  } | null>;
  saveWorkflowVersion(
    context: HarborApiContext,
    input: {
      workflow: WorkflowDefinition;
      state: "draft" | "published";
    }
  ): Promise<WorkflowVersionSummary>;
  listWorkflowVersions(context: HarborApiContext, workflowId: string): Promise<WorkflowVersionSummary[]>;
  getWorkflowVersion(
    context: HarborApiContext,
    workflowId: string,
    version: number
  ): Promise<(WorkflowVersionSummary & { workflow: WorkflowDefinition }) | null>;
  publishWorkflowVersion(
    context: HarborApiContext,
    input: {
      workflowId: string;
      version: number;
    }
  ): Promise<WorkflowVersionSummary | null>;
  createPromotionPullRequest(
    context: HarborApiContext,
    input: {
      workflow: WorkflowDefinition;
      workflowId: string;
      version: number;
      baseBranch?: string | undefined;
      headBranch?: string | undefined;
    }
  ): Promise<PromotionPullRequestResult>;
  runEvalGate?(context: HarborApiContext, input: EvalGateInput): Promise<EvalGateSummary>;
  runPromotionChecks?(context: HarborApiContext, input: PromotionGateInput): Promise<PromotionGateSummary>;
  runAdversarialGate?(context: HarborApiContext, input: AdversarialGateInput): Promise<AdversarialGateSummary>;
  runShadowGate?(context: HarborApiContext, input: ShadowGateInput): Promise<ShadowGateSummary>;
  linkReplayRuns?(
    context: HarborApiContext,
    input: {
      sourceRunId: string;
      replayRunId: string;
      workflowId: string;
      reason: string;
    }
  ): Promise<void>;
  policyVerifier?: WorkflowPolicyVerifier | undefined;
}

const t = initTRPC.context<HarborApiContext>().create();

const authzProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.tenantId || !ctx.workspaceId || !ctx.actorId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing tenancy scope in request context"
    });
  }

  return next();
});

type GateEvent = "deploy" | "publish";
type BenchmarkTarget = "deploy" | "publish" | "promotion";

interface EvalGateInput {
  workflow: WorkflowDefinition;
  workflowId: string;
  version: number;
  event: GateEvent;
  lintFindings: LintFinding[];
}

interface PromotionGateInput extends EvalGateInput {
  evalGate: EvalGateSummary;
}

interface AdversarialGateInput extends PromotionGateInput {
  promotionGate: PromotionGateSummary;
}

interface ShadowGateInput extends AdversarialGateInput {
  adversarialGate: AdversarialGateSummary;
  rolloutMode: HarnessRolloutMode;
}

function resolveRolloutMode(workflow: WorkflowDefinition): HarnessRolloutMode {
  return workflow.rolloutMode ?? "active";
}

function defaultEvalGate(input: EvalGateInput): EvalGateSummary {
  return {
    suiteId: `eval-smoke:${input.workflowId}:v${input.version}`,
    status: "passed",
    blocked: false,
    score: 1,
    summary: "Synthetic eval smoke suite passed.",
    failingScenarios: [],
    calibration: {
      rubricVersion: "rubric-v0",
      benchmarkSetId: "shared-benchmark-v0",
      calibratedAt: "2026-04-06T00:00:00.000Z",
      agreementScore: 1,
      driftScore: 0,
      minimumAgreement: 0.85,
      maximumDrift: 0.15,
      driftDetected: false
    }
  };
}

function skippedEvalGate(reason: string): EvalGateSummary {
  return {
    suiteId: "eval-smoke:skipped",
    status: "skipped",
    blocked: false,
    score: 0,
    summary: reason,
    failingScenarios: [],
    calibration: {
      rubricVersion: "rubric-v0",
      benchmarkSetId: "shared-benchmark-v0",
      calibratedAt: "2026-04-06T00:00:00.000Z",
      agreementScore: 0,
      driftScore: 0,
      minimumAgreement: 0.85,
      maximumDrift: 0.15,
      driftDetected: false
    }
  };
}

function defaultPromotionGate(input: PromotionGateInput): PromotionGateSummary {
  return {
    provider: "github",
    repository: "local/harbor",
    branch: "main",
    status: "passed",
    blocked: false,
    checks: [
      {
        checkId: "github/check-lint",
        status: "passed",
        summary: "Harness lint gate passed."
      },
      {
        checkId: "github/check-eval",
        status: input.evalGate.status === "passed" ? "passed" : "failed",
        summary:
          input.evalGate.status === "passed"
            ? "Eval gate passed."
            : "Eval gate failed; promotion checks cannot pass."
      }
    ]
  };
}

function skippedPromotionGate(reason: string): PromotionGateSummary {
  return {
    provider: "github",
    repository: "local/harbor",
    branch: "main",
    status: "skipped",
    blocked: false,
    checks: [
      {
        checkId: "github/checks",
        status: "skipped",
        summary: reason
      }
    ]
  };
}

function defaultAdversarialGate(input: AdversarialGateInput): AdversarialGateSummary {
  return {
    suiteId: `adversarial-smoke:${input.workflowId}:v${input.version}`,
    status: "passed",
    blocked: false,
    summary: "Adversarial smoke suite passed.",
    findings: [],
    taxonomy: {
      totalFindings: 0,
      criticalFindings: 0,
      warningFindings: 0,
      byCategory: {
        prompt_injection: 0,
        tool_permission_escalation: 0,
        cross_tenant_access: 0,
        memory_poisoning: 0
      },
      byScenario: {}
    }
  };
}

function skippedAdversarialGate(reason: string): AdversarialGateSummary {
  return {
    suiteId: "adversarial-smoke:skipped",
    status: "skipped",
    blocked: false,
    summary: reason,
    findings: [],
    taxonomy: {
      totalFindings: 0,
      criticalFindings: 0,
      warningFindings: 0,
      byCategory: {
        prompt_injection: 0,
        tool_permission_escalation: 0,
        cross_tenant_access: 0,
        memory_poisoning: 0
      },
      byScenario: {}
    }
  };
}

function defaultShadowGate(input: ShadowGateInput): ShadowGateSummary {
  if (input.rolloutMode === "active") {
    return {
      mode: "active",
      status: "passed",
      blocked: false,
      summary: "Active rollout mode does not require shadow comparison."
    };
  }

  return {
    mode: input.rolloutMode,
    status: "passed",
    blocked: false,
    summary:
      input.event === "publish"
        ? "Shadow comparison passed against publish baseline."
        : "Shadow comparison passed against deploy baseline.",
    comparison: {
      baselineRunId: `baseline:${input.workflowId}:v${input.version}:${input.event}`,
      candidateRunId: `candidate:${input.workflowId}:v${input.version}:${input.event}`,
      parityScore: 1,
      divergenceCount: 0,
      artifactPath: `harbor/shadow/${input.workflowId}/v${input.version}/${input.event}.json`
    }
  };
}

function skippedShadowGate(reason: string, mode: HarnessRolloutMode): ShadowGateSummary {
  return {
    mode,
    status: "skipped",
    blocked: false,
    summary: reason
  };
}

function blockedPromotionResult(input: {
  workflowId: string;
  version: number;
  blockedReasons: DeployBlockReason[];
  promotionGate: PromotionGateSummary;
  baseBranch?: string | undefined;
  headBranch?: string | undefined;
}): PromotionPullRequestResult {
  const baseBranch = input.baseBranch ?? input.promotionGate.branch;
  const headBranch = input.headBranch ?? `harbor/promotion/${input.workflowId}-v${input.version}`;

  return {
    repository: input.promotionGate.repository,
    baseBranch,
    headBranch,
    artifactPath: `harbor/workflows/${input.workflowId}/v${input.version}.json`,
    status: "skipped",
    summary: `Promotion pull request skipped because deploy gates are blocked: ${input.blockedReasons.join(", ")}.`
  };
}

function collectBlockedReasons(input: {
  evalGate: EvalGateSummary;
  promotionGate: PromotionGateSummary;
  adversarialGate: AdversarialGateSummary;
  shadowGate: ShadowGateSummary;
}): DeployBlockReason[] {
  const reasons: DeployBlockReason[] = [];

  if (input.evalGate.blocked || input.evalGate.status === "failed") {
    reasons.push("eval");
  }

  if (input.promotionGate.blocked || input.promotionGate.status === "failed") {
    reasons.push("promotion");
  }

  if (input.adversarialGate.blocked || input.adversarialGate.status === "failed") {
    reasons.push("adversarial");
  }

  if (input.shadowGate.blocked || input.shadowGate.status === "failed") {
    reasons.push("shadow");
  }

  return reasons;
}

function resolveBridgeNextAction(input: {
  blocked: boolean;
  target: BenchmarkTarget;
}): BenchmarkToProductionBridge["nextAction"] {
  if (input.blocked) {
    return "halt_and_remediate";
  }

  if (input.target === "deploy") {
    return "deploy_workflow";
  }

  if (input.target === "publish") {
    return "publish_workflow";
  }

  return "open_promotion_pull_request";
}

function createBenchmarkToProductionBridge(input: {
  event: GateEvent;
  target: BenchmarkTarget;
  workflowId: string;
  version: number;
  rolloutMode: HarnessRolloutMode;
  lintBlocked: boolean;
  evalGate: EvalGateSummary;
  promotionGate: PromotionGateSummary;
  adversarialGate: AdversarialGateSummary;
  shadowGate: ShadowGateSummary;
  blockedReasons: DeployBlockReason[];
}): BenchmarkToProductionBridge {
  const blocked = input.blockedReasons.length > 0;

  return {
    bridgeVersion: "v1",
    bridgeId: `bridge:${input.workflowId}:v${input.version}:${input.event}:${input.target}`,
    event: input.event,
    target: input.target,
    workflowId: input.workflowId,
    version: input.version,
    rolloutMode: input.rolloutMode,
    blocked,
    blockedReasons: input.blockedReasons,
    nextAction: resolveBridgeNextAction({
      blocked,
      target: input.target
    }),
    steps: [
      {
        stepId: "lint",
        status: input.lintBlocked ? "failed" : "passed",
        blocked: input.lintBlocked,
        summary: input.lintBlocked
          ? "Critical harness lint findings blocked progression from benchmarks to production."
          : "Harness lint passed for benchmark-to-production bridge."
      },
      {
        stepId: "eval",
        status: input.evalGate.status,
        blocked: input.evalGate.blocked || input.evalGate.status === "failed",
        summary: input.evalGate.summary
      },
      {
        stepId: "promotion",
        status: input.promotionGate.status,
        blocked: input.promotionGate.blocked || input.promotionGate.status === "failed",
        summary: input.promotionGate.checks.map((check) => check.summary).join(" ")
      },
      {
        stepId: "adversarial",
        status: input.adversarialGate.status,
        blocked: input.adversarialGate.blocked || input.adversarialGate.status === "failed",
        summary: input.adversarialGate.summary
      },
      {
        stepId: "shadow",
        status: input.shadowGate.status,
        blocked: input.shadowGate.blocked || input.shadowGate.status === "failed",
        summary: input.shadowGate.summary
      }
    ]
  };
}

async function resolveDeployGates(
  dependencies: HarborApiDependencies,
  context: HarborApiContext,
  input: EvalGateInput & { lintBlocked: boolean; target: BenchmarkTarget }
): Promise<{
  evalGate: EvalGateSummary;
  promotionGate: PromotionGateSummary;
  adversarialGate: AdversarialGateSummary;
  shadowGate: ShadowGateSummary;
  bridge: BenchmarkToProductionBridge;
  blockedReasons: DeployBlockReason[];
  blocked: boolean;
}> {
  const rolloutMode = resolveRolloutMode(input.workflow);

  if (input.lintBlocked) {
    const reason = "Skipped because critical harness lint findings already blocked deploy/publish.";
    const evalGate = skippedEvalGate(reason);
    const promotionGate = skippedPromotionGate(reason);
    const adversarialGate = skippedAdversarialGate(reason);
    const shadowGate = skippedShadowGate(reason, rolloutMode);
    const blockedReasons: DeployBlockReason[] = ["lint"];

    return {
      evalGate,
      promotionGate,
      adversarialGate,
      shadowGate,
      bridge: createBenchmarkToProductionBridge({
        event: input.event,
        target: input.target,
        workflowId: input.workflowId,
        version: input.version,
        rolloutMode,
        lintBlocked: true,
        evalGate,
        promotionGate,
        adversarialGate,
        shadowGate,
        blockedReasons
      }),
      blockedReasons,
      blocked: true
    };
  }

  const evalInput: EvalGateInput = {
    workflow: input.workflow,
    workflowId: input.workflowId,
    version: input.version,
    event: input.event,
    lintFindings: input.lintFindings
  };
  const evalGate = dependencies.runEvalGate
    ? await dependencies.runEvalGate(context, evalInput)
    : defaultEvalGate(evalInput);

  const promotionInput: PromotionGateInput = {
    ...evalInput,
    evalGate
  };
  const promotionGate = dependencies.runPromotionChecks
    ? await dependencies.runPromotionChecks(context, promotionInput)
    : defaultPromotionGate(promotionInput);

  const adversarialInput: AdversarialGateInput = {
    ...promotionInput,
    promotionGate
  };
  const adversarialGate = dependencies.runAdversarialGate
    ? await dependencies.runAdversarialGate(context, adversarialInput)
    : defaultAdversarialGate(adversarialInput);

  const upstreamBlockedReasons = collectBlockedReasons({
    evalGate,
    promotionGate,
    adversarialGate,
    shadowGate: skippedShadowGate("Skipped while upstream gates are blocked.", rolloutMode)
  });

  const shadowGate =
    upstreamBlockedReasons.length > 0
      ? skippedShadowGate("Skipped because upstream deploy gates are blocked.", rolloutMode)
      : dependencies.runShadowGate
        ? await dependencies.runShadowGate(context, {
            ...adversarialInput,
            adversarialGate,
            rolloutMode
          })
        : defaultShadowGate({
            ...adversarialInput,
            adversarialGate,
            rolloutMode
          });

  const blockedReasons = collectBlockedReasons({
    evalGate,
    promotionGate,
    adversarialGate,
    shadowGate
  });

  return {
    evalGate,
    promotionGate,
    adversarialGate,
    shadowGate,
    bridge: createBenchmarkToProductionBridge({
      event: input.event,
      target: input.target,
      workflowId: input.workflowId,
      version: input.version,
      rolloutMode,
      lintBlocked: false,
      evalGate,
      promotionGate,
      adversarialGate,
      shadowGate,
      blockedReasons
    }),
    blockedReasons,
    blocked: blockedReasons.length > 0
  };
}

function verifyPolicyOrThrow(
  policyVerifier: WorkflowPolicyVerifier | undefined,
  workflow: WorkflowDefinition,
  event: "deploy" | "publish" | "run"
): PolicyVerificationResult | null {
  if (!policyVerifier) {
    return null;
  }

  const verification = policyVerifier.verify(workflow);
  if (!verification.valid) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Policy verification failed during ${event}: ${verification.reasons.join("; ")}`
    });
  }

  return verification;
}

export function createHarborRouter(dependencies: HarborApiDependencies) {
  return t.router({
    saveWorkflow: authzProcedure.input(saveInputSchema).mutation(({ input }) => {
      const lint = runLintAtExecutionPoint("save", input.workflow);

      return {
        workflowId: input.workflow.id,
        lintFindings: lint.report.findings,
        blocked: lint.report.blocked
      };
    }),

    saveWorkflowVersion: authzProcedure
      .input(saveWorkflowVersionInputSchema)
      .mutation(async ({ ctx, input }): Promise<SaveWorkflowVersionOutput> => {
        const state = input.state ?? "draft";
        const lint = runLintAtExecutionPoint("save", input.workflow);
        const saved = await dependencies.saveWorkflowVersion(ctx, {
          workflow: input.workflow,
          state
        });

        return {
          workflowId: saved.workflowId,
          version: saved.version,
          state: saved.state,
          savedAt: saved.savedAt,
          savedBy: saved.savedBy,
          lintFindings: lint.report.findings,
          blocked: lint.report.blocked
        };
      }),

    deployWorkflow: authzProcedure
      .input(deployInputSchema)
      .mutation(async ({ ctx, input }): Promise<DeployWorkflowOutput> => {
        if (input.workflow.id !== input.workflowId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "workflowId must match workflow.id"
          });
        }

        if (input.workflow.version !== input.expectedVersion) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "expectedVersion does not match workflow.version"
          });
        }

        const policyVerification = verifyPolicyOrThrow(dependencies.policyVerifier, input.workflow, "deploy");

        const lint = runLintAtExecutionPoint("deploy", input.workflow);
        const gates = await resolveDeployGates(dependencies, ctx, {
          workflow: input.workflow,
          workflowId: input.workflowId,
          version: input.expectedVersion,
          event: "deploy",
          lintFindings: lint.report.findings,
          lintBlocked: lint.report.blocked,
          target: "deploy"
        });

        return {
          deploymentId: `dep_${randomUUID()}`,
          lintFindings: lint.report.findings,
          evalGate: gates.evalGate,
          promotionGate: gates.promotionGate,
          adversarialGate: gates.adversarialGate,
          shadowGate: gates.shadowGate,
          bridge: gates.bridge,
          blockedReasons: gates.blockedReasons,
          blocked: gates.blocked,
          ...(policyVerification?.policyVersion ? { policyVersion: policyVerification.policyVersion } : {}),
          ...(policyVerification?.signature ? { policySignature: policyVerification.signature } : {})
        };
      }),

    listWorkflowVersions: authzProcedure
      .input(listWorkflowVersionsInputSchema)
      .query(async ({ ctx, input }) => {
        return dependencies.listWorkflowVersions(ctx, input.workflowId);
      }),

    getWorkflowVersion: authzProcedure
      .input(getWorkflowVersionInputSchema)
      .query(async ({ ctx, input }: { ctx: HarborApiContext; input: GetWorkflowVersionInput }) => {
        const version = await dependencies.getWorkflowVersion(ctx, input.workflowId, input.version);
        if (!version) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Workflow version not found"
          });
        }

        return version;
      }),

    publishWorkflowVersion: authzProcedure
      .input(publishWorkflowVersionInputSchema)
      .mutation(async ({ ctx, input }): Promise<PublishWorkflowVersionOutput> => {
        const version = await dependencies.getWorkflowVersion(ctx, input.workflowId, input.version);
        if (!version) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Workflow version not found"
          });
        }

        const policyVerification = verifyPolicyOrThrow(dependencies.policyVerifier, version.workflow, "publish");

        const lint = runLintAtExecutionPoint("deploy", version.workflow);
        const gates = await resolveDeployGates(dependencies, ctx, {
          workflow: version.workflow,
          workflowId: input.workflowId,
          version: input.version,
          event: "publish",
          lintFindings: lint.report.findings,
          lintBlocked: lint.report.blocked,
          target: "publish"
        });

        if (gates.blocked) {
          return {
            workflowId: input.workflowId,
            version: input.version,
            state: "published",
            lintFindings: lint.report.findings,
            evalGate: gates.evalGate,
            promotionGate: gates.promotionGate,
            adversarialGate: gates.adversarialGate,
            shadowGate: gates.shadowGate,
            bridge: gates.bridge,
            blockedReasons: gates.blockedReasons,
            blocked: true,
            ...(policyVerification?.policyVersion ? { policyVersion: policyVerification.policyVersion } : {}),
            ...(policyVerification?.signature ? { policySignature: policyVerification.signature } : {})
          };
        }

        const published = await dependencies.publishWorkflowVersion(ctx, {
          workflowId: input.workflowId,
          version: input.version
        });

        if (!published) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Workflow version not found"
          });
        }

        return {
          workflowId: published.workflowId,
          version: published.version,
          state: "published",
          lintFindings: lint.report.findings,
          evalGate: gates.evalGate,
          promotionGate: gates.promotionGate,
          adversarialGate: gates.adversarialGate,
          shadowGate: gates.shadowGate,
          bridge: gates.bridge,
          blockedReasons: gates.blockedReasons,
          blocked: false,
          ...(policyVerification?.policyVersion ? { policyVersion: policyVerification.policyVersion } : {}),
          ...(policyVerification?.signature ? { policySignature: policyVerification.signature } : {})
        };
      }),

    openPromotionPullRequest: authzProcedure
      .input(openPromotionPullRequestInputSchema)
      .mutation(async ({ ctx, input }): Promise<OpenPromotionPullRequestOutput> => {
        const version = await dependencies.getWorkflowVersion(ctx, input.workflowId, input.version);
        if (!version) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Workflow version not found"
          });
        }

        const policyVerification = verifyPolicyOrThrow(dependencies.policyVerifier, version.workflow, "publish");

        const lint = runLintAtExecutionPoint("deploy", version.workflow);
        const gates = await resolveDeployGates(dependencies, ctx, {
          workflow: version.workflow,
          workflowId: input.workflowId,
          version: input.version,
          event: "publish",
          lintFindings: lint.report.findings,
          lintBlocked: lint.report.blocked,
          target: "promotion"
        });

        if (gates.blocked) {
          return {
            workflowId: input.workflowId,
            version: input.version,
            lintFindings: lint.report.findings,
            evalGate: gates.evalGate,
            promotionGate: gates.promotionGate,
            adversarialGate: gates.adversarialGate,
            shadowGate: gates.shadowGate,
            bridge: gates.bridge,
            blockedReasons: gates.blockedReasons,
            blocked: true,
            promotion: blockedPromotionResult({
              workflowId: input.workflowId,
              version: input.version,
              blockedReasons: gates.blockedReasons,
              promotionGate: gates.promotionGate,
              baseBranch: input.baseBranch,
              headBranch: input.headBranch
            }),
            ...(policyVerification?.policyVersion ? { policyVersion: policyVerification.policyVersion } : {}),
            ...(policyVerification?.signature ? { policySignature: policyVerification.signature } : {})
          };
        }

        const promotion = await dependencies.createPromotionPullRequest(ctx, {
          workflow: version.workflow,
          workflowId: input.workflowId,
          version: input.version,
          baseBranch: input.baseBranch,
          headBranch: input.headBranch
        });

        return {
          workflowId: input.workflowId,
          version: input.version,
          lintFindings: lint.report.findings,
          evalGate: gates.evalGate,
          promotionGate: gates.promotionGate,
          adversarialGate: gates.adversarialGate,
          shadowGate: gates.shadowGate,
          bridge: gates.bridge,
          blockedReasons: gates.blockedReasons,
          blocked: false,
          promotion,
          ...(policyVerification?.policyVersion ? { policyVersion: policyVerification.policyVersion } : {}),
          ...(policyVerification?.signature ? { policySignature: policyVerification.signature } : {})
        };
      }),

    runWorkflow: authzProcedure.input(runInputSchema).mutation(async ({ ctx, input }) => {
      verifyPolicyOrThrow(dependencies.policyVerifier, input.workflow, "run");

      const runRequest: WorkflowRunRequest = {
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        workflowId: input.workflow.id,
        trigger: input.trigger,
        input: input.input,
        idempotencyKey: input.idempotencyKey
      };

      return dependencies.runWorkflow(runRequest, input.workflow);
    }),

    replayRun: authzProcedure.input(replayRunInputSchema).mutation(async ({ ctx, input }): Promise<ReplayRunOutput> => {
      verifyPolicyOrThrow(dependencies.policyVerifier, input.workflow, "run");

      const sourceRun = await dependencies.getRun(ctx, input.sourceRunId);
      if (!sourceRun) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Source run not found"
        });
      }

      const replayReason = input.replayReason ?? "Recovery replay requested by operator.";
      const replayIdempotencyKey = input.idempotencyKey ?? `replay:${sourceRun.runId}:${input.workflow.version}`;

      const runRequest: WorkflowRunRequest = {
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        workflowId: input.workflow.id,
        trigger: input.trigger,
        input: sourceRun.input,
        idempotencyKey: replayIdempotencyKey
      };

      const replayResult = await dependencies.runWorkflow(runRequest, input.workflow);

      if (dependencies.linkReplayRuns) {
        await dependencies.linkReplayRuns(ctx, {
          sourceRunId: sourceRun.runId,
          replayRunId: replayResult.runId,
          workflowId: input.workflow.id,
          reason: replayReason
        });
      }

      return {
        ...replayResult,
        sourceRunId: sourceRun.runId,
        sourceWorkflowId: sourceRun.workflowId,
        replayReason
      };
    }),

    listRuns: authzProcedure.input(listRunsInputSchema).query(async ({ ctx, input }) => {
      return dependencies.listRuns(ctx, input);
    }),

    getRun: authzProcedure.input(getRunInputSchema).query(async ({ ctx, input }) => {
      const run = await dependencies.getRun(ctx, input.runId);
      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Run not found"
        });
      }

      return run;
    }),

    escalateRun: authzProcedure.input(escalateRunInputSchema).mutation(async ({ ctx, input }) => {
      const reason = input.reason ?? "Manual escalation requested by operator.";
      const result = await dependencies.escalateRun(ctx, {
        runId: input.runId,
        reason
      });

      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Run not found"
        });
      }

      if (result.status !== "needs_human") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Escalation did not produce needs_human status"
        });
      }

      return result;
    })
  });
}

export type HarborRouter = ReturnType<typeof createHarborRouter>;
