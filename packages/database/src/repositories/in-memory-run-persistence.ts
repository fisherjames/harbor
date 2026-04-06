import { randomUUID } from "node:crypto";
import type { LintFinding, WorkflowDefinition } from "@harbor/harness";
import type {
  IdempotentRunLookupResult,
  RunStatus,
  StageExecutionRecord,
  WorkflowRunRequest
} from "@harbor/engine";
import type {
  EscalateRunInput,
  ListStuckRunsInput,
  ListRunsInput,
  RunDetail,
  RunEscalationResult,
  RunStore,
  StuckRunCandidate,
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
  statusTransitionKeys: Set<string>;
  stageTransitionKeys: Set<string>;
  stageTransitionRecords: Map<string, StageExecutionRecord>;
  createdAt: string;
  updatedAt: string;
}

export class InMemoryRunPersistence implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runIdempotencyIndex = new Map<string, string>();

  async resolveIdempotentRun(request: WorkflowRunRequest): Promise<IdempotentRunLookupResult | null> {
    const idempotencyKey = this.idempotencyScopeKey(request);
    if (!idempotencyKey) {
      return null;
    }

    const runId = this.runIdempotencyIndex.get(idempotencyKey);
    if (!runId) {
      return null;
    }

    const run = this.runs.get(runId);
    if (!run) {
      this.runIdempotencyIndex.delete(idempotencyKey);
      return null;
    }

    return {
      runId,
      status: run.status,
      details: run.details
    };
  }

  async createRun(request: WorkflowRunRequest, workflow: WorkflowDefinition): Promise<string> {
    const existing = await this.resolveIdempotentRun(request);
    if (existing) {
      return existing.runId;
    }

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
      statusTransitionKeys: new Set<string>(),
      stageTransitionKeys: new Set<string>(),
      stageTransitionRecords: new Map<string, StageExecutionRecord>(),
      createdAt: now,
      updatedAt: now
    });

    const idempotencyKey = this.idempotencyScopeKey(request);
    if (idempotencyKey) {
      this.runIdempotencyIndex.set(idempotencyKey, runId);
    }

    return runId;
  }

  async updateStatus(
    runId: string,
    status: RunStatus,
    details?: Record<string, unknown>,
    transitionKey?: string
  ): Promise<void> {
    const run = this.getRunRecord(runId);
    if (transitionKey && run.statusTransitionKeys.has(transitionKey)) {
      return;
    }

    if (transitionKey) {
      run.statusTransitionKeys.add(transitionKey);
    }

    run.status = status;
    run.details = details;
    run.updatedAt = new Date().toISOString();
  }

  async addLintFindings(runId: string, findings: LintFinding[]): Promise<void> {
    const run = this.getRunRecord(runId);
    run.lintFindings = findings;
    run.updatedAt = new Date().toISOString();
  }

  async appendStage(runId: string, record: StageExecutionRecord, transitionKey?: string): Promise<void> {
    const run = this.getRunRecord(runId);
    if (transitionKey && run.stageTransitionKeys.has(transitionKey)) {
      return;
    }

    if (transitionKey) {
      run.stageTransitionKeys.add(transitionKey);
      run.stageTransitionRecords.set(transitionKey, record);
    }

    run.stages.push(record);
    run.updatedAt = new Date().toISOString();
  }

  async resolveStageReplay(runId: string, transitionKey: string): Promise<StageExecutionRecord | null> {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }

    const record = run.stageTransitionRecords.get(transitionKey);
    return record ? structuredClone(record) : null;
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

  async listStuckRuns(input: ListStuckRunsInput): Promise<StuckRunCandidate[]> {
    const staleAfterMs = Math.max(0, input.staleAfterSeconds) * 1000;
    const nowMs = Date.now();

    const staleRuns = [...this.runs.values()]
      .filter((run) => run.status === "running")
      .filter((run) => nowMs - new Date(run.updatedAt).getTime() >= staleAfterMs)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, input.limit ?? 100);

    return staleRuns.map((run) => ({
      runId: run.runId,
      tenantId: run.request.tenantId,
      workspaceId: run.request.workspaceId,
      workflowId: run.workflow.id,
      status: "running",
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    }));
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

  private idempotencyScopeKey(request: WorkflowRunRequest): string | null {
    const key = request.idempotencyKey?.trim();
    if (!key) {
      return null;
    }

    return `${request.tenantId}:${request.workspaceId}:${request.workflowId}:${key}`;
  }
}
