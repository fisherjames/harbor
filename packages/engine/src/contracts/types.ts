import type { LintFinding, WorkflowDefinition } from "@harbor/harness";

export type RunStage = "plan" | "execute" | "verify" | "fix";
export type RunStatus = "queued" | "running" | "needs_human" | "failed" | "completed";

export interface WorkflowRunRequest {
  tenantId: string;
  workspaceId: string;
  workflowId: string;
  trigger: "manual" | "schedule" | "api";
  input: Record<string, unknown>;
  actorId: string;
  idempotencyKey?: string | undefined;
}

export interface WorkflowRunResult {
  runId: string;
  status: RunStatus;
  finalOutput?: Record<string, unknown>;
}

export interface StageExecutionRecord {
  stage: RunStage;
  startedAt: string;
  completedAt: string;
  prompt: string;
  output: string;
  attempts: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  lintFindings: LintFinding[];
}

export interface RunContext {
  request: WorkflowRunRequest;
  workflow: WorkflowDefinition;
  runId: string;
}
