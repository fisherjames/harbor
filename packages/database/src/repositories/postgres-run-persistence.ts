import { randomUUID } from "node:crypto";
import { Pool } from "pg";
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

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

interface Queryable {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

interface ExecutionRow {
  id: string;
  workflow_id: string;
  status: RunStatus;
  trigger: "manual" | "schedule" | "api";
  actor_id: string;
  input: unknown;
  output: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StageRow {
  stage: "plan" | "execute" | "verify" | "fix";
  prompt: string;
  output: string;
  attempts: number;
  token_usage: unknown;
  started_at: Date | string;
  completed_at: Date | string;
}

interface ArtifactRow {
  name: string;
  value: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }

  return value as Record<string, unknown>;
}

function parseLintFindings(artifacts: ArtifactRow[]): LintFinding[] {
  const lintArtifact = [...artifacts].reverse().find((artifact) => artifact.name === "__lint-findings");
  if (!lintArtifact) {
    return [];
  }

  return JSON.parse(lintArtifact.value) as LintFinding[];
}

function parseTokenUsage(value: unknown): StageExecutionRecord["tokenUsage"] {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return JSON.parse(value) as StageExecutionRecord["tokenUsage"];
  }

  return value as StageExecutionRecord["tokenUsage"];
}

export class PostgresRunPersistence implements RunStore {
  constructor(private readonly db: Queryable) {}

  async createRun(request: WorkflowRunRequest, _workflow: WorkflowDefinition): Promise<string> {
    const runId = `run_${randomUUID()}`;
    await this.db.query(
      `INSERT INTO executions (id, workflow_id, tenant_id, workspace_id, status, trigger, actor_id, input)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        runId,
        request.workflowId,
        request.tenantId,
        request.workspaceId,
        "queued",
        request.trigger,
        request.actorId,
        JSON.stringify(request.input)
      ]
    );

    return runId;
  }

  async updateStatus(runId: string, status: RunStatus, details?: Record<string, unknown>): Promise<void> {
    const detailsJson = details ? JSON.stringify(details) : null;
    const result = await this.db.query(
      `UPDATE executions
       SET status = $2,
           output = COALESCE($3::jsonb, output),
           updated_at = NOW()
       WHERE id = $1`,
      [runId, status, detailsJson]
    );

    if (result.rowCount === 0) {
      throw new Error(`Unknown runId: ${runId}`);
    }
  }

  async addLintFindings(runId: string, findings: LintFinding[]): Promise<void> {
    await this.storeArtifact(runId, "__lint-findings", JSON.stringify(findings));
  }

  async appendStage(runId: string, record: StageExecutionRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO execution_stages
       (id, execution_id, stage, prompt, output, attempts, token_usage, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)`,
      [
        `stage_${randomUUID()}`,
        runId,
        record.stage,
        record.prompt,
        record.output,
        record.attempts,
        record.tokenUsage ? JSON.stringify(record.tokenUsage) : null,
        record.startedAt,
        record.completedAt
      ]
    );

    await this.db.query("UPDATE executions SET updated_at = NOW() WHERE id = $1", [runId]);
  }

  async storeArtifact(runId: string, name: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO artifacts (id, execution_id, name, value)
       VALUES ($1, $2, $3, $4)`,
      [`artifact_${randomUUID()}`, runId, name, value]
    );

    await this.db.query("UPDATE executions SET updated_at = NOW() WHERE id = $1", [runId]);
  }

  async listRuns(scope: RunStoreScope, input: ListRunsInput = {}): Promise<RunSummary[]> {
    const params: unknown[] = [scope.tenantId, scope.workspaceId];
    let where = "tenant_id = $1 AND workspace_id = $2";

    if (input.status) {
      params.push(input.status);
      where += ` AND status = $${params.length}`;
    }

    if (input.workflowId) {
      params.push(input.workflowId);
      where += ` AND workflow_id = $${params.length}`;
    }

    params.push(input.limit ?? 20);

    const runs = await this.db.query<ExecutionRow>(
      `SELECT id, workflow_id, status, trigger, actor_id, input, output, created_at, updated_at
       FROM executions
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    const summaries: RunSummary[] = [];
    for (const run of runs.rows) {
      const stages = await this.db.query<StageRow>(
        `SELECT stage, prompt, output, attempts, token_usage, started_at, completed_at
         FROM execution_stages
         WHERE execution_id = $1`,
        [run.id]
      );

      const usage = tokenUsageFromStages(
        stages.rows.map((stage) => ({
          ...(function stageRecord() {
            const tokenUsage = parseTokenUsage(stage.token_usage);
            return {
              stage: stage.stage,
              startedAt: toIso(stage.started_at),
              completedAt: toIso(stage.completed_at),
              prompt: stage.prompt,
              output: stage.output,
              attempts: stage.attempts,
              ...(tokenUsage ? { tokenUsage } : {}),
              lintFindings: []
            };
          })()
        }))
      );

      summaries.push({
        runId: run.id,
        workflowId: run.workflow_id,
        status: run.status,
        trigger: run.trigger,
        actorId: run.actor_id,
        createdAt: toIso(run.created_at),
        updatedAt: toIso(run.updated_at),
        tokenUsage: usage
      });
    }

    return summaries;
  }

  async getRun(scope: RunStoreScope, runId: string): Promise<RunDetail | null> {
    const execution = await this.db.query<ExecutionRow>(
      `SELECT id, workflow_id, status, trigger, actor_id, input, output, created_at, updated_at
       FROM executions
       WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3`,
      [runId, scope.tenantId, scope.workspaceId]
    );

    const row = execution.rows[0];
    if (!row) {
      return null;
    }

    const stages = await this.db.query<StageRow>(
      `SELECT stage, prompt, output, attempts, token_usage, started_at, completed_at
       FROM execution_stages
       WHERE execution_id = $1
       ORDER BY started_at ASC`,
      [runId]
    );
    const artifacts = await this.db.query<ArtifactRow>(
      `SELECT name, value
       FROM artifacts
       WHERE execution_id = $1
       ORDER BY created_at ASC`,
      [runId]
    );

    const stageRecords: StageExecutionRecord[] = stages.rows.map((stage) => {
      const tokenUsage = parseTokenUsage(stage.token_usage);
      return {
        stage: stage.stage,
        startedAt: toIso(stage.started_at),
        completedAt: toIso(stage.completed_at),
        prompt: stage.prompt,
        output: stage.output,
        attempts: stage.attempts,
        ...(tokenUsage ? { tokenUsage } : {}),
        lintFindings: []
      };
    });

    const artifactMap = artifacts.rows.reduce<Record<string, string>>(
      (acc, artifact) => ({
        ...acc,
        [artifact.name]: artifact.value
      }),
      {}
    );

    return {
      runId: row.id,
      workflowId: row.workflow_id,
      status: row.status,
      trigger: row.trigger,
      actorId: row.actor_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      tokenUsage: tokenUsageFromStages(stageRecords),
      input: parseJsonRecord(row.input) ?? {},
      output: parseJsonRecord(row.output),
      details: parseJsonRecord(row.output),
      lintFindings: parseLintFindings(artifacts.rows),
      stages: stageRecords,
      artifacts: artifactMap
    };
  }

  async escalateRun(scope: RunStoreScope, input: EscalateRunInput): Promise<RunEscalationResult | null> {
    const result = await this.db.query(
      `UPDATE executions
       SET status = 'needs_human',
           output = COALESCE(output, '{}'::jsonb) || $4::jsonb,
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3`,
      [
        input.runId,
        scope.tenantId,
        scope.workspaceId,
        JSON.stringify({
          escalationReason: input.reason,
          escalatedBy: input.actorId
        })
      ]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const updatedAt = new Date().toISOString();
    await this.db.query(
      `INSERT INTO audit_logs (id, tenant_id, workspace_id, actor_id, action, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        `audit_${randomUUID()}`,
        scope.tenantId,
        scope.workspaceId,
        input.actorId,
        "run.manual_escalation",
        JSON.stringify({
          runId: input.runId,
          reason: input.reason
        })
      ]
    );

    await this.storeArtifact(
      input.runId,
      "manual-escalation",
      JSON.stringify({ reason: input.reason, actorId: input.actorId, updatedAt })
    );

    return {
      runId: input.runId,
      status: "needs_human",
      updatedAt
    };
  }
}

export function createPostgresRunPersistence(connectionString: string): PostgresRunPersistence {
  if (!connectionString.trim()) {
    throw new Error("DATABASE_URL is required for postgres run persistence");
  }

  const pool = new Pool({ connectionString });
  return new PostgresRunPersistence(pool);
}
