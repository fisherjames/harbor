import { randomUUID } from "node:crypto";
import type { LintFinding, WorkflowDefinition } from "@harbor/harness";
import type { RunPersistence, StageExecutionRecord, WorkflowRunRequest } from "@harbor/engine";

interface RunRecord {
  runId: string;
  request: WorkflowRunRequest;
  workflow: WorkflowDefinition;
  status: string;
  details: Record<string, unknown> | undefined;
  lintFindings: LintFinding[];
  stages: StageExecutionRecord[];
  artifacts: Record<string, string>;
}

export class InMemoryRunPersistence implements RunPersistence {
  private readonly runs = new Map<string, RunRecord>();

  async createRun(request: WorkflowRunRequest, workflow: WorkflowDefinition): Promise<string> {
    const runId = `run_${randomUUID()}`;
    this.runs.set(runId, {
      runId,
      request,
      workflow,
      status: "queued",
      details: undefined,
      lintFindings: [],
      stages: [],
      artifacts: {}
    });

    return runId;
  }

  async updateStatus(runId: string, status: string, details?: Record<string, unknown>): Promise<void> {
    const run = this.getRun(runId);
    run.status = status;
    run.details = details;
  }

  async addLintFindings(runId: string, findings: LintFinding[]): Promise<void> {
    const run = this.getRun(runId);
    run.lintFindings = findings;
  }

  async appendStage(runId: string, record: StageExecutionRecord): Promise<void> {
    const run = this.getRun(runId);
    run.stages.push(record);
  }

  async storeArtifact(runId: string, name: string, value: string): Promise<void> {
    const run = this.getRun(runId);
    run.artifacts[name] = value;
  }

  getSnapshot(runId: string): RunRecord {
    return structuredClone(this.getRun(runId));
  }

  private getRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown runId: ${runId}`);
    }

    return run;
  }
}
