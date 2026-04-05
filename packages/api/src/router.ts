import { randomUUID } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { runLintAtExecutionPoint, type WorkflowDefinition } from "@harbor/harness";
import type { RunStatus, WorkflowRunRequest, WorkflowRunResult } from "@harbor/engine";
import type {
  DeployWorkflowOutput,
  HarborApiContext,
  ListRunsInput,
  RunDetail,
  RunSummary
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
        toolPermissionScope: z.array(z.string()).optional()
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
  input: z.record(z.unknown())
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

    deployWorkflow: authzProcedure.input(deployInputSchema).mutation(({ input }): DeployWorkflowOutput => {
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

      return {
        deploymentId: `dep_${randomUUID()}`,
        lintFindings: lint.report.findings,
        blocked: lint.report.blocked
      };
    }),

    runWorkflow: authzProcedure.input(runInputSchema).mutation(async ({ ctx, input }) => {
      const runRequest: WorkflowRunRequest = {
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        workflowId: input.workflow.id,
        trigger: input.trigger,
        input: input.input
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
