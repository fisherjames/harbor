import { randomUUID } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { runLintAtExecutionPoint, type LintFinding, type WorkflowDefinition } from "@harbor/harness";
import type { RunStatus, WorkflowRunRequest, WorkflowRunResult } from "@harbor/engine";
import type {
  DeployBlockReason,
  EvalGateSummary,
  PromotionGateSummary,
  DeployWorkflowOutput,
  GetWorkflowVersionInput,
  HarborApiContext,
  ListRunsInput,
  OpenPromotionPullRequestOutput,
  PromotionPullRequestResult,
  PublishWorkflowVersionOutput,
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

const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().min(1),
  objective: z.string().min(1),
  systemPrompt: z.string().min(1),
  memoryPolicy: memoryPolicySchema.optional(),
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
            maxCalls: z.number().int().min(1)
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

function defaultEvalGate(input: EvalGateInput): EvalGateSummary {
  return {
    suiteId: `eval-smoke:${input.workflowId}:v${input.version}`,
    status: "passed",
    blocked: false,
    score: 1,
    summary: "Synthetic eval smoke suite passed.",
    failingScenarios: []
  };
}

function skippedEvalGate(reason: string): EvalGateSummary {
  return {
    suiteId: "eval-smoke:skipped",
    status: "skipped",
    blocked: false,
    score: 0,
    summary: reason,
    failingScenarios: []
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
}): DeployBlockReason[] {
  const reasons: DeployBlockReason[] = [];

  if (input.evalGate.blocked || input.evalGate.status === "failed") {
    reasons.push("eval");
  }

  if (input.promotionGate.blocked || input.promotionGate.status === "failed") {
    reasons.push("promotion");
  }

  return reasons;
}

async function resolveDeployGates(
  dependencies: HarborApiDependencies,
  context: HarborApiContext,
  input: EvalGateInput & { lintBlocked: boolean }
): Promise<{
  evalGate: EvalGateSummary;
  promotionGate: PromotionGateSummary;
  blockedReasons: DeployBlockReason[];
  blocked: boolean;
}> {
  if (input.lintBlocked) {
    const reason = "Skipped because critical harness lint findings already blocked deploy/publish.";
    const evalGate = skippedEvalGate(reason);
    const promotionGate = skippedPromotionGate(reason);

    return {
      evalGate,
      promotionGate,
      blockedReasons: ["lint"],
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

  const blockedReasons = collectBlockedReasons({
    evalGate,
    promotionGate
  });

  return {
    evalGate,
    promotionGate,
    blockedReasons,
    blocked: blockedReasons.length > 0
  };
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

        const lint = runLintAtExecutionPoint("deploy", input.workflow);
        const gates = await resolveDeployGates(dependencies, ctx, {
          workflow: input.workflow,
          workflowId: input.workflowId,
          version: input.expectedVersion,
          event: "deploy",
          lintFindings: lint.report.findings,
          lintBlocked: lint.report.blocked
        });

        return {
          deploymentId: `dep_${randomUUID()}`,
          lintFindings: lint.report.findings,
          evalGate: gates.evalGate,
          promotionGate: gates.promotionGate,
          blockedReasons: gates.blockedReasons,
          blocked: gates.blocked
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

        const lint = runLintAtExecutionPoint("deploy", version.workflow);
        const gates = await resolveDeployGates(dependencies, ctx, {
          workflow: version.workflow,
          workflowId: input.workflowId,
          version: input.version,
          event: "publish",
          lintFindings: lint.report.findings,
          lintBlocked: lint.report.blocked
        });

        if (gates.blocked) {
          return {
            workflowId: input.workflowId,
            version: input.version,
            state: "published",
            lintFindings: lint.report.findings,
            evalGate: gates.evalGate,
            promotionGate: gates.promotionGate,
            blockedReasons: gates.blockedReasons,
            blocked: true
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
          blockedReasons: gates.blockedReasons,
          blocked: false
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

        const lint = runLintAtExecutionPoint("deploy", version.workflow);
        const gates = await resolveDeployGates(dependencies, ctx, {
          workflow: version.workflow,
          workflowId: input.workflowId,
          version: input.version,
          event: "publish",
          lintFindings: lint.report.findings,
          lintBlocked: lint.report.blocked
        });

        if (gates.blocked) {
          return {
            workflowId: input.workflowId,
            version: input.version,
            lintFindings: lint.report.findings,
            evalGate: gates.evalGate,
            promotionGate: gates.promotionGate,
            blockedReasons: gates.blockedReasons,
            blocked: true,
            promotion: blockedPromotionResult({
              workflowId: input.workflowId,
              version: input.version,
              blockedReasons: gates.blockedReasons,
              promotionGate: gates.promotionGate,
              baseBranch: input.baseBranch,
              headBranch: input.headBranch
            })
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
          blockedReasons: gates.blockedReasons,
          blocked: false,
          promotion
        };
      }),

    runWorkflow: authzProcedure.input(runInputSchema).mutation(async ({ ctx, input }) => {
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
