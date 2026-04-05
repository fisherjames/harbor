import { randomUUID } from "node:crypto";
import type { LintFinding, WorkflowDefinition } from "@harbor/harness";
import type { RunStatus, StageExecutionRecord, WorkflowRunRequest } from "@harbor/engine";
import type {
  EscalateRunInput,
  ListRunsInput,
  RunDetail,
  RunEscalationResult,
  RunStore,
  RunStoreScope,
  RunSummary
} from "./run-store.js";
import { tokenUsageFromStages } from "./run-store.js";

interface RunRecord {
  runId: string;
  request: WorkflowRunRequest;
  workflow: WorkflowDefinition;
  status: RunStatus;
  details: Record<string, unknown> | undefined;
  lintFindings: LintFinding[];
  stages: StageExecutionRecord[];
  artifacts: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export class InMemoryRunPersistence implements RunStore {
  private readonly runs = new Map<string, RunRecord>();

  async createRun(request: WorkflowRunRequest, workflow: WorkflowDefinition): Promise<string> {
    const now = new Date().toISOString();
    const runId = `run_${randomUUID()}`;
    this.runs.set(runId, {
      runId,
      request,
      workflow,
      status: "queued",
      details: undefined,
      lintFindings: [],
      stages: [],
      artifacts: {},
      createdAt: now,
      updatedAt: now
    });

    return runId;
  }

  async updateStatus(runId: string, status: RunStatus, details?: Record<string, unknown>): Promise<void> {
    const run = this.getRunRecord(runId);
    run.status = status;
    run.details = details;
    run.updatedAt = new Date().toISOString();
  }

  async addLintFindings(runId: string, findings: LintFinding[]): Promise<void> {
    const run = this.getRunRecord(runId);
    run.lintFindings = findings;
    run.updatedAt = new Date().toISOString();
  }

  async appendStage(runId: string, record: StageExecutionRecord): Promise<void> {
    const run = this.getRunRecord(runId);
    run.stages.push(record);
    run.updatedAt = new Date().toISOString();
  }

  async storeArtifact(runId: string, name: string, value: string): Promise<void> {
    const run = this.getRunRecord(runId);
    run.artifacts[name] = value;
    run.updatedAt = new Date().toISOString();
  }

  async listRuns(scope: RunStoreScope, input: ListRunsInput = {}): Promise<RunSummary[]> {
    const filtered = [...this.runs.values()].filter(
      (run) =>
        run.request.tenantId === scope.tenantId &&
        run.request.workspaceId === scope.workspaceId &&
        (!input.status || run.status === input.status) &&
        (!input.workflowId || run.workflow.id === input.workflowId)
    );

    const sorted = filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limited = sorted.slice(0, input.limit ?? 20);

    return limited.map((run) => ({
      runId: run.runId,
      workflowId: run.workflow.id,
      status: run.status,
      trigger: run.request.trigger,
      actorId: run.request.actorId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      tokenUsage: tokenUsageFromStages(run.stages)
    }));
  }

  async getRun(scope: RunStoreScope, runId: string): Promise<RunDetail | null> {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }

    if (run.request.tenantId !== scope.tenantId || run.request.workspaceId !== scope.workspaceId) {
      return null;
    }

    return {
      runId: run.runId,
      workflowId: run.workflow.id,
      status: run.status,
      trigger: run.request.trigger,
      actorId: run.request.actorId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      tokenUsage: tokenUsageFromStages(run.stages),
      input: run.request.input,
      output: run.details,
      details: run.details,
      lintFindings: run.lintFindings,
      stages: structuredClone(run.stages),
      artifacts: structuredClone(run.artifacts)
    };
  }

  async escalateRun(scope: RunStoreScope, input: EscalateRunInput): Promise<RunEscalationResult | null> {
    const run = this.runs.get(input.runId);
    if (!run) {
      return null;
    }

    if (run.request.tenantId !== scope.tenantId || run.request.workspaceId !== scope.workspaceId) {
      return null;
    }

    const updatedAt = new Date().toISOString();
    run.status = "needs_human";
    run.updatedAt = updatedAt;
    run.details = {
      ...(run.details ?? {}),
      escalationReason: input.reason,
      escalatedBy: input.actorId
    };
    run.artifacts["manual-escalation"] = JSON.stringify({
      reason: input.reason,
      actorId: input.actorId,
      updatedAt
    });

    return {
      runId: run.runId,
      status: "needs_human",
      updatedAt
    };
  }

  getSnapshot(runId: string): RunRecord {
    return structuredClone(this.getRunRecord(runId));
  }

  private getRunRecord(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown runId: ${runId}`);
    }

    return run;
  }
}
