import type { RunPersistence, RunStatus, StageExecutionRecord } from "@harbor/engine";
import type { LintFinding } from "@harbor/harness";

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
  actorId: string;
  reason: string;
}

export interface RunStoreScope {
  tenantId: string;
  workspaceId: string;
}

export interface RunEscalationResult {
  runId: string;
  status: "needs_human";
  updatedAt: string;
}

export interface ListStuckRunsInput {
  staleAfterSeconds: number;
  limit?: number | undefined;
}

export interface StuckRunCandidate {
  runId: string;
  tenantId: string;
  workspaceId: string;
  workflowId: string;
  status: "running";
  createdAt: string;
  updatedAt: string;
}

export interface RunStore extends RunPersistence {
  listRuns(scope: RunStoreScope, input?: ListRunsInput): Promise<RunSummary[]>;
  getRun(scope: RunStoreScope, runId: string): Promise<RunDetail | null>;
  escalateRun(scope: RunStoreScope, input: EscalateRunInput): Promise<RunEscalationResult | null>;
  listStuckRuns(input: ListStuckRunsInput): Promise<StuckRunCandidate[]>;
}

export const DEFAULT_TOKEN_COST_PER_1K = 0.01;

export function tokenUsageFromStages(stages: StageExecutionRecord[]): RunTokenUsage {
  const inputTokens = stages.reduce((sum, stage) => sum + (stage.tokenUsage?.inputTokens ?? 0), 0);
  const outputTokens = stages.reduce((sum, stage) => sum + (stage.tokenUsage?.outputTokens ?? 0), 0);
  const totalTokens = stages.reduce((sum, stage) => sum + (stage.tokenUsage?.totalTokens ?? 0), 0);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: Number(((totalTokens / 1000) * DEFAULT_TOKEN_COST_PER_1K).toFixed(6))
  };
}
