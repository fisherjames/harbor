import type { LintFinding, WorkflowDefinition } from "@harbor/harness";
import type { RunStatus, StageExecutionRecord } from "@harbor/engine";

export interface DeployWorkflowInput {
  workflowId: string;
  expectedVersion: number;
  workflow: WorkflowDefinition;
}

export interface DeployWorkflowOutput {
  deploymentId: string;
  lintFindings: LintFinding[];
  blocked: boolean;
}

export interface HarborApiContext {
  tenantId: string;
  workspaceId: string;
  actorId: string;
}

export interface RunTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  status: RunStatus;
  trigger: "manual" | "schedule" | "api";
  actorId: string;
  createdAt: string;
  updatedAt: string;
  tokenUsage: RunTokenUsage;
}

export interface RunDetail extends RunSummary {
  input: Record<string, unknown>;
  output?: Record<string, unknown> | undefined;
  details?: Record<string, unknown> | undefined;
  lintFindings: LintFinding[];
  stages: StageExecutionRecord[];
  artifacts: Record<string, string>;
}

export interface ListRunsInput {
  limit?: number | undefined;
  status?: RunStatus | undefined;
  workflowId?: string | undefined;
}

export interface EscalateRunInput {
  runId: string;
  reason?: string | undefined;
}

export interface EscalateRunOutput {
  runId: string;
  status: "needs_human";
  updatedAt: string;
}

export type WorkflowVersionState = "draft" | "published";

export interface WorkflowVersionSummary {
  workflowId: string;
  version: number;
  state: WorkflowVersionState;
  savedAt: string;
  savedBy: string;
}

export interface SaveWorkflowVersionInput {
  workflow: WorkflowDefinition;
  state?: WorkflowVersionState | undefined;
}

export interface SaveWorkflowVersionOutput extends WorkflowVersionSummary {
  lintFindings: LintFinding[];
  blocked: boolean;
}

export interface ListWorkflowVersionsInput {
  workflowId: string;
}

export interface PublishWorkflowVersionInput {
  workflowId: string;
  version: number;
}

export interface PublishWorkflowVersionOutput {
  workflowId: string;
  version: number;
  state: "published";
  lintFindings: LintFinding[];
  blocked: boolean;
}
