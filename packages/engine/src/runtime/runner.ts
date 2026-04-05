import {
  assembleStagePrompt,
  filterFindingsForPrompt,
  generateRemediationRecommendations,
  runLintAtExecutionPoint,
  summarizePostRunFindings,
  type WorkflowDefinition
} from "@harbor/harness";
import type { MemuWriteInput } from "@harbor/memu";
import type { RunIsolationSession, WorkflowRunnerDependencies } from "../contracts/runtime.js";
import type { RunContext, RunStage, RunStatus, WorkflowRunRequest, WorkflowRunResult } from "../contracts/types.js";
import { withRetry } from "./retry.js";

const STAGES: RunStage[] = ["plan", "execute", "verify"];

function toolPolicySnapshot(workflow: WorkflowDefinition): Array<{
  nodeId: string;
  scope: string[];
  timeoutMs: number | null;
  retryLimit: number | null;
  maxCalls: number | null;
}> {
  return workflow.nodes
    .filter((node) => node.type === "tool_call")
    .map((node) => ({
      nodeId: node.id,
      scope: node.toolPermissionScope ?? [],
      timeoutMs: node.toolCallPolicy?.timeoutMs ?? null,
      retryLimit: node.toolCallPolicy?.retryLimit ?? null,
      maxCalls: node.toolCallPolicy?.maxCalls ?? null
    }));
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function resolutionStepsFromFindings(findings: ReturnType<typeof filterFindingsForPrompt>): string[] {
  return uniquePreserveOrder(findings.flatMap((finding) => finding.resolutionSteps));
}

function stageNodeType(stage: RunStage): "planner" | "executor" | "verifier" {
  if (stage === "plan") {
    return "planner";
  }

  if (stage === "verify") {
    return "verifier";
  }

  return "executor";
}

function verifyPassed(output: string): boolean {
  const normalized = output.toUpperCase();
  return normalized.includes("PASS") && !normalized.includes("FAIL");
}

function statusTransitionKey(status: RunStatus, reason?: string): string {
  if (!reason) {
    return `status:${status}`;
  }

  return `status:${status}:${reason}`;
}

async function readMemoryContext(
  stage: RunStage,
  context: RunContext,
  dependencies: WorkflowRunnerDependencies
): Promise<string | undefined> {
  const policy = context.workflow.memoryPolicy;

  if (!policy) {
    return undefined;
  }

  if (stage !== "plan" && stage !== "verify") {
    return undefined;
  }

  const response = await dependencies.memu.readContext({
    tenantId: context.request.tenantId,
    workspaceId: context.request.workspaceId,
    agentId: context.workflow.id,
    runId: context.runId,
    query: context.workflow.objective,
    mode: policy.retrievalMode,
    maxItems: policy.maxContextItems
  });

  return response.compressedPrompt ?? response.items.map((item) => `- ${item.title}: ${item.content}`).join("\n");
}

async function writeMemory(
  stage: RunStage,
  output: string,
  context: RunContext,
  dependencies: WorkflowRunnerDependencies
): Promise<void> {
  const policy = context.workflow.memoryPolicy;
  if (!policy?.writebackEnabled || (stage !== "execute" && stage !== "fix")) {
    return;
  }

  const input: MemuWriteInput = {
    tenantId: context.request.tenantId,
    workspaceId: context.request.workspaceId,
    agentId: context.workflow.id,
    category: "workflow-runs",
    path: `${context.workflow.id}/${context.runId}/${stage}.md`,
    content: output,
    metadata: {
      stage,
      piiRetention: policy.piiRetention,
      trigger: context.request.trigger
    }
  };

  await dependencies.memu.writeMemory(input);
}

async function runSingleStage(
  stage: RunStage,
  context: RunContext,
  dependencies: WorkflowRunnerDependencies,
  nonBlockingFindings: ReturnType<typeof filterFindingsForPrompt>,
  stageTransitionKey: string
): Promise<string> {
  if (dependencies.persistence.resolveStageReplay) {
    const replay = await dependencies.persistence.resolveStageReplay(context.runId, stageTransitionKey);
    if (replay) {
      dependencies.tracer.finding({
        runId: context.runId,
        workflowId: context.workflow.id,
        stage,
        message: "Stage replay deduplicated by transition key",
        metadata: {
          transitionKey: stageTransitionKey,
          attempts: replay.attempts
        }
      });

      return replay.output;
    }
  }

  const startedAt = new Date().toISOString();
  const nodeType = stageNodeType(stage);
  const node = context.workflow.nodes.find((workflowNode) => workflowNode.type === nodeType);
  const retries = node?.retryLimit ?? 0;
  const timeoutMs = node?.timeoutMs ?? 5_000;

  const memoryContext = await readMemoryContext(stage, context, dependencies);

  const promptInput = {
    stage,
    workflow: context.workflow,
    baseTask: `${context.workflow.systemPrompt}\n\nInput: ${JSON.stringify(context.request.input)}`,
    lintFindings: nonBlockingFindings,
    ...(memoryContext ? { memoryContext } : {})
  } as const;

  const prompt = assembleStagePrompt(promptInput);

  dependencies.tracer.stageStart({
    runId: context.runId,
    workflowId: context.workflow.id,
    stage,
    message: "Stage started",
    metadata: {
      timeoutMs,
      retries
    }
  });

  const execution = await withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await dependencies.model.generate({
        stage,
        prompt,
        context
      });
    } finally {
      clearTimeout(timer);
    }
  }, retries, 120);

  const stageRecord = {
    stage,
    startedAt,
    completedAt: new Date().toISOString(),
    prompt,
    output: execution.value.output,
    attempts: execution.attempts,
    lintFindings: nonBlockingFindings,
    ...(execution.value.tokenUsage ? { tokenUsage: execution.value.tokenUsage } : {})
  };

  await dependencies.persistence.appendStage(context.runId, stageRecord, stageTransitionKey);

  await writeMemory(stage, execution.value.output, context, dependencies);

  dependencies.tracer.stageEnd({
    runId: context.runId,
    workflowId: context.workflow.id,
    stage,
    message: "Stage completed",
    metadata: {
      attempts: execution.attempts,
      latencyMs: execution.value.latencyMs,
      totalTokens: execution.value.tokenUsage?.totalTokens ?? 0
    }
  });

  return execution.value.output;
}

export function createWorkflowRunner(dependencies: WorkflowRunnerDependencies) {
  const maxFixAttempts = dependencies.maxFixAttempts ?? 1;

  return {
    async runWorkflow(request: WorkflowRunRequest, workflow: WorkflowDefinition): Promise<WorkflowRunResult> {
      if (request.idempotencyKey && dependencies.persistence.resolveIdempotentRun) {
        const deduped = await dependencies.persistence.resolveIdempotentRun(request);
        if (deduped) {
          dependencies.tracer.finding({
            runId: deduped.runId,
            workflowId: workflow.id,
            message: "Idempotent run request deduplicated",
            metadata: {
              status: deduped.status
            }
          });

          return {
            runId: deduped.runId,
            status: deduped.status,
            ...(deduped.details ? { finalOutput: deduped.details } : {})
          };
        }
      }

      const runId = await dependencies.persistence.createRun(request, workflow);

      await dependencies.persistence.updateStatus(runId, "running", undefined, statusTransitionKey("running"));

      const context: RunContext = {
        request,
        workflow,
        runId
      };
      let isolationSession: RunIsolationSession | undefined;
      let outcome: RunStatus = "running";
      let stageTransitionIndex = 0;
      const nextStageTransitionKey = (stage: RunStage): string => {
        stageTransitionIndex += 1;
        return `stage:${stage}:${stageTransitionIndex}`;
      };
      const teardownIsolation = async (): Promise<void> => {
        if (!isolationSession) {
          return;
        }

        try {
          await dependencies.runIsolation!.teardown(context, isolationSession, outcome);
        } catch (error) {
          const err = error as Error;

          dependencies.tracer.error({
            runId,
            workflowId: workflow.id,
            message: "Run isolation teardown failed",
            error: err
          });

          await dependencies.persistence
            .storeArtifact(runId, "run-isolation-teardown-error", err.message)
            .catch(() => undefined);
        }
      };

      if (dependencies.runIsolation) {
        try {
          isolationSession = await dependencies.runIsolation.setup(context);
          await dependencies.persistence.storeArtifact(runId, "run-isolation-session", JSON.stringify(isolationSession));
        } catch (error) {
          const err = error as Error;
          outcome = "failed";

          dependencies.tracer.error({
            runId,
            workflowId: workflow.id,
            message: "Run isolation setup failed",
            error: err
          });

          await dependencies.persistence.storeArtifact(runId, "run-isolation-setup-error", err.message);
          await dependencies.persistence.updateStatus(runId, "failed", {
            reason: "run_isolation_setup_failed",
            detail: err.message
          }, statusTransitionKey("failed", "run_isolation_setup_failed"));
          await teardownIsolation();

          return {
            runId,
            status: "failed",
            finalOutput: {
              reason: "run_isolation_setup_failed",
              detail: err.message
            }
          };
        }
      }

      try {
        const lintReport = runLintAtExecutionPoint("runtime-pre-stage", workflow).report;
        await dependencies.persistence.addLintFindings(runId, lintReport.findings);

        for (const finding of lintReport.findings) {
          dependencies.tracer.finding({
            runId,
            workflowId: workflow.id,
            message: finding.message,
            metadata: {
              ruleId: finding.ruleId,
              severity: finding.severity
            }
          });
        }

        const toolPolicies = toolPolicySnapshot(workflow);
        if (toolPolicies.length > 0) {
          await dependencies.persistence.storeArtifact(runId, "tool-execution-policy", JSON.stringify(toolPolicies));
        }

        if (lintReport.blocked) {
          outcome = "failed";
          await dependencies.persistence.updateStatus(runId, "failed", {
            reason: "critical_lint_findings"
          }, statusTransitionKey("failed", "critical_lint_findings"));
          await teardownIsolation();

          return {
            runId,
            status: "failed",
            finalOutput: {
              reason: "critical_lint_findings",
              lintFindings: lintReport.findings
            }
          };
        }

        const nonBlockingFindings = filterFindingsForPrompt(lintReport.findings);
        const resolutionSteps = resolutionStepsFromFindings(nonBlockingFindings);

        if (resolutionSteps.length > 0) {
          await dependencies.persistence.storeArtifact(runId, "harness-resolution-steps", JSON.stringify(resolutionSteps));
        }

        await runSingleStage(
          "plan",
          context,
          dependencies,
          nonBlockingFindings,
          nextStageTransitionKey("plan")
        );
        const executeOutput = await runSingleStage(
          "execute",
          context,
          dependencies,
          nonBlockingFindings,
          nextStageTransitionKey("execute")
        );
        let verifyOutput = await runSingleStage(
          "verify",
          context,
          dependencies,
          nonBlockingFindings,
          nextStageTransitionKey("verify")
        );

        if (!verifyPassed(verifyOutput)) {
          for (let fixAttempt = 0; fixAttempt < maxFixAttempts; fixAttempt += 1) {
            await dependencies.persistence.storeArtifact(
              runId,
              `verify-failure-${fixAttempt + 1}`,
              verifyOutput
            );

            await runSingleStage(
              "fix",
              context,
              dependencies,
              nonBlockingFindings,
              nextStageTransitionKey("fix")
            );
            verifyOutput = await runSingleStage(
              "verify",
              context,
              dependencies,
              nonBlockingFindings,
              nextStageTransitionKey("verify")
            );

            if (verifyPassed(verifyOutput)) {
              break;
            }
          }
        }

        if (!verifyPassed(verifyOutput)) {
          outcome = "needs_human";
          await dependencies.persistence.updateStatus(runId, "needs_human", {
            reason: "verification_failed"
          }, statusTransitionKey("needs_human", "verification_failed"));
          await teardownIsolation();

          return {
            runId,
            status: "needs_human",
            finalOutput: {
              reason: "verification_failed"
            }
          };
        }

        const postRunSummary = summarizePostRunFindings([
          {
            workflowVersion: workflow.version,
            findings: lintReport.findings
          }
        ]);

        await dependencies.persistence.storeArtifact(runId, "post-run-lint-summary", JSON.stringify(postRunSummary));
        await dependencies.persistence.storeArtifact(
          runId,
          "post-run-remediation-recommendations",
          JSON.stringify(generateRemediationRecommendations(postRunSummary))
        );

        await dependencies.persistence.updateStatus(runId, "completed", undefined, statusTransitionKey("completed"));
        outcome = "completed";
        await teardownIsolation();

        return {
          runId,
          status: "completed",
          finalOutput: {
            output: executeOutput,
            verification: verifyOutput
          }
        };
      } catch (error) {
        const err = error as Error;

        dependencies.tracer.error({
          runId,
          workflowId: workflow.id,
          message: "Workflow run failed",
          error: err
        });

        await dependencies.persistence.updateStatus(runId, "failed", {
          reason: err.message
        }, statusTransitionKey("failed", "runtime_error"));
        outcome = "failed";
        await teardownIsolation();

        return {
          runId,
          status: "failed",
          finalOutput: {
            reason: err.message
          }
        };
      }
    }
  };
}
