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

export interface IdempotentRunLookupResult {
  runId: string;
  status: RunStatus;
  details?: Record<string, unknown> | undefined;
}

export interface RunPersistence {
  createRun(request: WorkflowRunRequest, workflow: WorkflowDefinition): Promise<string>;
  resolveIdempotentRun?(request: WorkflowRunRequest): Promise<IdempotentRunLookupResult | null>;
  resolveStageReplay?(runId: string, transitionKey: string): Promise<StageExecutionRecord | null>;
  updateStatus(
    runId: string,
    status: RunStatus,
    details?: Record<string, unknown>,
    transitionKey?: string
  ): Promise<void>;
  addLintFindings(runId: string, findings: LintFinding[]): Promise<void>;
  appendStage(runId: string, record: StageExecutionRecord, transitionKey?: string): Promise<void>;
  storeArtifact(runId: string, name: string, value: string): Promise<void>;
}

export interface RunIsolationSession {
  worktreePath: string;
  observabilitySessionId: string;
  observabilityExpiresAt: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface RunIsolationManager {
  setup(context: RunContext): Promise<RunIsolationSession>;
  teardown(context: RunContext, session: RunIsolationSession, outcome: RunStatus): Promise<void>;
}

export interface WorkflowRunnerDependencies {
  model: ModelProvider;
  memu: MemuClient;
  persistence: RunPersistence;
  tracer: HarborRunTracer;
  runIsolation?: RunIsolationManager | undefined;
  maxFixAttempts?: number;
}
