import type { LintFinding, WorkflowDefinition } from "@harbor/harness";
import type { MemuClient } from "@harbor/memu";
import type { HarborRunTracer } from "@harbor/observability";
import type { RunContext, RunStage, RunStatus, StageExecutionRecord, WorkflowRunRequest } from "./types.js";

export interface ModelInvocation {
  stage: RunStage;
  prompt: string;
  context: RunContext;
}

export interface ModelInvocationResult {
  output: string;
  latencyMs: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface ModelProvider {
  generate(input: ModelInvocation): Promise<ModelInvocationResult>;
}

export interface RunPersistence {
  createRun(request: WorkflowRunRequest, workflow: WorkflowDefinition): Promise<string>;
  updateStatus(runId: string, status: RunStatus, details?: Record<string, unknown>): Promise<void>;
  addLintFindings(runId: string, findings: LintFinding[]): Promise<void>;
  appendStage(runId: string, record: StageExecutionRecord): Promise<void>;
  storeArtifact(runId: string, name: string, value: string): Promise<void>;
}

export interface WorkflowRunnerDependencies {
  model: ModelProvider;
  memu: MemuClient;
  persistence: RunPersistence;
  tracer: HarborRunTracer;
  maxFixAttempts?: number;
}
