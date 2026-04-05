import {
  assembleStagePrompt,
  filterFindingsForPrompt,
  runLintAtExecutionPoint,
  summarizePostRunFindings,
  type WorkflowDefinition
} from "@harbor/harness";
import type { MemuWriteInput } from "@harbor/memu";
import type { WorkflowRunnerDependencies } from "../contracts/runtime.js";
import type { RunContext, RunStage, WorkflowRunRequest, WorkflowRunResult } from "../contracts/types.js";
import { withRetry } from "./retry.js";

const STAGES: RunStage[] = ["plan", "execute", "verify"];

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
  nonBlockingFindings: ReturnType<typeof filterFindingsForPrompt>
): Promise<string> {
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

  await dependencies.persistence.appendStage(context.runId, stageRecord);

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
      const runId = await dependencies.persistence.createRun(request, workflow);

      await dependencies.persistence.updateStatus(runId, "running");

      const context: RunContext = {
        request,
        workflow,
        runId
      };

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

      if (lintReport.blocked) {
        await dependencies.persistence.updateStatus(runId, "failed", {
          reason: "critical_lint_findings"
        });

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

      try {
        await runSingleStage("plan", context, dependencies, nonBlockingFindings);
        const executeOutput = await runSingleStage("execute", context, dependencies, nonBlockingFindings);
        let verifyOutput = await runSingleStage("verify", context, dependencies, nonBlockingFindings);

        if (!verifyPassed(verifyOutput)) {
          for (let fixAttempt = 0; fixAttempt < maxFixAttempts; fixAttempt += 1) {
            await dependencies.persistence.storeArtifact(
              runId,
              `verify-failure-${fixAttempt + 1}`,
              verifyOutput
            );

            await runSingleStage("fix", context, dependencies, nonBlockingFindings);
            verifyOutput = await runSingleStage("verify", context, dependencies, nonBlockingFindings);

            if (verifyPassed(verifyOutput)) {
              break;
            }
          }
        }

        if (!verifyPassed(verifyOutput)) {
          await dependencies.persistence.updateStatus(runId, "needs_human", {
            reason: "verification_failed"
          });

          return {
            runId,
            status: "needs_human",
            finalOutput: {
              reason: "verification_failed"
            }
          };
        }

        await dependencies.persistence.storeArtifact(
          runId,
          "post-run-lint-summary",
          JSON.stringify(
            summarizePostRunFindings([
              {
                workflowVersion: workflow.version,
                findings: lintReport.findings
              }
            ])
          )
        );

        await dependencies.persistence.updateStatus(runId, "completed");

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
        });

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
