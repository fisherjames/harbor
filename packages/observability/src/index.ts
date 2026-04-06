import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";

export interface HarborTraceEvent {
  runId: string;
  workflowId: string;
  stage?: string;
  message: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface HarborRunTracer {
  stageStart(event: HarborTraceEvent): void;
  stageEnd(event: HarborTraceEvent): void;
  finding(event: HarborTraceEvent): void;
  error(event: HarborTraceEvent & { error: Error }): void;
}

interface ReplayMemoryReadSnapshot {
  mode?: unknown;
}

interface MemoryConflictArtifact {
  conflicts?: unknown;
  droppedMemoryIds?: unknown;
}

export interface HarborMemoryTrustMetrics {
  memoryReadCount: number;
  monitorReadCount: number;
  reasonReadCount: number;
  stageConflictArtifactCount: number;
  latestConflictCount: number;
  latestDroppedMemoryIds: string[];
  latestDroppedMemoryCount: number;
  conflictRate: number;
}

export interface HarborRunStageObservation {
  startedAt: string;
  completedAt: string;
}

export interface HarborRunHealthObservation {
  runId: string;
  workflowId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stages?: HarborRunStageObservation[] | undefined;
  artifacts?: Record<string, string> | undefined;
}

export interface HarborRunHealthFacets {
  totalRuns: number;
  queuedRuns: number;
  runningRuns: number;
  stuckRuns: number;
  needsHumanRuns: number;
  failedRuns: number;
  completedRuns: number;
  recoveredRuns: number;
  deadLetterRuns: number;
  replayParentRuns: number;
  replayChildRuns: number;
  replayParityBaselineRuns: number;
  replayDivergenceRuns: number;
  replayMissingManifestRuns: number;
}

export interface HarborWorkflowReliabilitySummary {
  workflowId: string;
  runCount: number;
  completedRuns: number;
  failedRuns: number;
  runningRuns: number;
  needsHumanRuns: number;
  recoveredRuns: number;
  deadLetterRuns: number;
  replayDivergenceRuns: number;
  p95LatencyMs: number;
  failureRate: number;
  needsHumanRate: number;
  deadLetterRate: number;
}

export type HarborReliabilityAlertCategory = "failure_rate" | "needs_human_rate" | "dead_letter_rate" | "latency_p95";
export type HarborReliabilityAlertSeverity = "warning" | "critical";

export interface HarborReliabilityAlert {
  alertId: string;
  workflowId: string;
  category: HarborReliabilityAlertCategory;
  severity: HarborReliabilityAlertSeverity;
  message: string;
  observed: number;
  threshold: number;
  runCount: number;
}

export interface HarborReliabilityAlertBudget {
  minimumRuns: number;
  maxFailureRate: number;
  maxNeedsHumanRate: number;
  maxDeadLetterRate: number;
  maxP95LatencyMs: number;
}

export interface HarborReliabilityAlertHookPayload {
  generatedAt: string;
  budget: HarborReliabilityAlertBudget;
  alertCount: number;
  alerts: HarborReliabilityAlert[];
}

class OtelRunTracer implements HarborRunTracer {
  constructor(private readonly serviceName: string) {}

  stageStart(event: HarborTraceEvent): void {
    this.withSpan("stage.start", event, () => undefined);
  }

  stageEnd(event: HarborTraceEvent): void {
    this.withSpan("stage.end", event, () => undefined);
  }

  finding(event: HarborTraceEvent): void {
    this.withSpan("finding", event, () => undefined);
  }

  error(event: HarborTraceEvent & { error: Error }): void {
    this.withSpan("error", event, (span) => {
      span.recordException(event.error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: event.error.message });
    });
  }

  private withSpan(name: string, event: HarborTraceEvent, cb: (span: Span) => void): void {
    const tracer = trace.getTracer(this.serviceName);
    const span = tracer.startSpan(`harbor.${name}`);

    span.setAttribute("harbor.run_id", event.runId);
    span.setAttribute("harbor.workflow_id", event.workflowId);
    span.setAttribute("harbor.message", event.message);

    if (event.stage) {
      span.setAttribute("harbor.stage", event.stage);
    }

    for (const [key, value] of Object.entries(event.metadata ?? {})) {
      span.setAttribute(`harbor.${key}`, value);
    }

    cb(span);
    span.end();
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function replayMemoryReadSnapshots(value: unknown): ReplayMemoryReadSnapshot[] {
  if (!isRecord(value)) {
    return [];
  }

  const snapshots = value["memoryReadSnapshots"];
  if (!Array.isArray(snapshots)) {
    return [];
  }

  return snapshots.filter((snapshot): snapshot is ReplayMemoryReadSnapshot => isRecord(snapshot));
}

function memoryConflictArtifact(value: unknown): MemoryConflictArtifact {
  if (!isRecord(value)) {
    return {};
  }

  return value;
}

function hasArtifact(artifacts: Record<string, string> | undefined, name: string): boolean {
  if (!artifacts) {
    return false;
  }

  return typeof artifacts[name] === "string";
}

function replayDivergenceCount(artifacts: Record<string, string> | undefined): number {
  if (!artifacts) {
    return 0;
  }

  const parsed = parseJson(artifacts["replay-divergence-taxonomy"]);
  if (!isRecord(parsed)) {
    return 0;
  }

  let count = 0;
  for (const value of Object.values(parsed)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      count += value;
    }
  }

  return count;
}

function replayManifestExists(artifacts: Record<string, string> | undefined): boolean {
  if (!artifacts) {
    return false;
  }

  return Boolean(parseJson(artifacts["replay-bundle-manifest"]));
}

function parseIsoMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function runLatencyMs(observation: HarborRunHealthObservation): number {
  const stages = observation.stages ?? [];
  if (stages.length > 0) {
    const startedTimes = stages.map((stage) => parseIsoMs(stage.startedAt)).filter(Number.isFinite);
    const completedTimes = stages.map((stage) => parseIsoMs(stage.completedAt)).filter(Number.isFinite);
    if (startedTimes.length > 0 && completedTimes.length > 0) {
      const earliest = Math.min(...startedTimes);
      const latest = Math.max(...completedTimes);
      if (latest >= earliest) {
        return latest - earliest;
      }
    }
  }

  const createdAtMs = parseIsoMs(observation.createdAt);
  const updatedAtMs = parseIsoMs(observation.updatedAt);
  if (Number.isFinite(createdAtMs) && Number.isFinite(updatedAtMs) && updatedAtMs >= createdAtMs) {
    return updatedAtMs - createdAtMs;
  }

  return 0;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] as number;
}

function safeRate(numerator: number, denominator: number): number {
  // Workflow summaries always have at least one run by construction.
  return Number((numerator / denominator).toFixed(4));
}

function alertSeverity(observed: number, threshold: number): HarborReliabilityAlertSeverity {
  if (observed >= threshold * 1.5) {
    return "critical";
  }

  return "warning";
}

function buildAlertId(workflowId: string, category: HarborReliabilityAlertCategory): string {
  return `${workflowId}:${category}`;
}

export function deriveMemoryTrustMetricsFromArtifacts(artifacts: Record<string, string>): HarborMemoryTrustMetrics {
  const manifest = parseJson(artifacts["replay-bundle-manifest"]);
  const snapshots = replayMemoryReadSnapshots(manifest);
  const memoryReadCount = snapshots.length;
  const monitorReadCount = snapshots.filter((snapshot) => snapshot.mode === "monitor").length;
  const reasonReadCount = snapshots.filter((snapshot) => snapshot.mode === "reason").length;

  const stageConflictArtifactCount = Object.keys(artifacts).filter((name) => name.startsWith("memory-conflict-stage_"))
    .length;
  const latestConflict = memoryConflictArtifact(parseJson(artifacts["memory-conflict-latest"]));
  const latestConflicts = Array.isArray(latestConflict.conflicts) ? latestConflict.conflicts : [];
  const latestDroppedMemoryIds = stringArray(latestConflict.droppedMemoryIds);
  const latestDroppedMemoryCount = latestDroppedMemoryIds.length;
  const conflictRate =
    memoryReadCount === 0 ? 0 : Number((stageConflictArtifactCount / memoryReadCount).toFixed(4));

  return {
    memoryReadCount,
    monitorReadCount,
    reasonReadCount,
    stageConflictArtifactCount,
    latestConflictCount: latestConflicts.length,
    latestDroppedMemoryIds,
    latestDroppedMemoryCount,
    conflictRate
  };
}

export function deriveRunHealthFacets(
  observations: HarborRunHealthObservation[],
  input: {
    staleAfterSeconds?: number | undefined;
    now?: Date | undefined;
  } = {}
): HarborRunHealthFacets {
  const staleAfterSeconds = input.staleAfterSeconds ?? 900;
  const nowMs = (input.now ?? new Date()).getTime();
  const facets: HarborRunHealthFacets = {
    totalRuns: observations.length,
    queuedRuns: 0,
    runningRuns: 0,
    stuckRuns: 0,
    needsHumanRuns: 0,
    failedRuns: 0,
    completedRuns: 0,
    recoveredRuns: 0,
    deadLetterRuns: 0,
    replayParentRuns: 0,
    replayChildRuns: 0,
    replayParityBaselineRuns: 0,
    replayDivergenceRuns: 0,
    replayMissingManifestRuns: 0
  };

  for (const observation of observations) {
    if (observation.status === "queued") {
      facets.queuedRuns += 1;
    } else if (observation.status === "running") {
      facets.runningRuns += 1;
      const updatedAtMs = parseIsoMs(observation.updatedAt);
      const isStuck =
        Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= Math.max(0, staleAfterSeconds) * 1000;
      if (isStuck) {
        facets.stuckRuns += 1;
      }
    } else if (observation.status === "needs_human") {
      facets.needsHumanRuns += 1;
    } else if (observation.status === "failed") {
      facets.failedRuns += 1;
    } else if (observation.status === "completed") {
      facets.completedRuns += 1;
    }

    const artifacts = observation.artifacts;
    if (hasArtifact(artifacts, "stuck-run-recovery")) {
      facets.recoveredRuns += 1;
    }
    if (hasArtifact(artifacts, "stuck-run-dead-letter")) {
      facets.deadLetterRuns += 1;
    }
    if (hasArtifact(artifacts, "replay-parent-run")) {
      facets.replayParentRuns += 1;
    }
    if (hasArtifact(artifacts, "replay-child-run")) {
      facets.replayChildRuns += 1;
    }

    const divergence = replayDivergenceCount(artifacts);
    if (divergence > 0) {
      facets.replayDivergenceRuns += 1;
    } else if (replayManifestExists(artifacts)) {
      facets.replayParityBaselineRuns += 1;
    } else {
      facets.replayMissingManifestRuns += 1;
    }
  }

  return facets;
}

export function deriveWorkflowReliabilitySummaries(
  observations: HarborRunHealthObservation[]
): HarborWorkflowReliabilitySummary[] {
  const byWorkflow = new Map<string, HarborRunHealthObservation[]>();
  for (const observation of observations) {
    const bucket = byWorkflow.get(observation.workflowId);
    if (bucket) {
      bucket.push(observation);
      continue;
    }

    byWorkflow.set(observation.workflowId, [observation]);
  }

  const summaries: HarborWorkflowReliabilitySummary[] = [];
  for (const [workflowId, runs] of byWorkflow.entries()) {
    const runCount = runs.length;
    const completedRuns = runs.filter((run) => run.status === "completed").length;
    const failedRuns = runs.filter((run) => run.status === "failed").length;
    const runningRuns = runs.filter((run) => run.status === "running").length;
    const needsHumanRuns = runs.filter((run) => run.status === "needs_human").length;
    const recoveredRuns = runs.filter((run) => hasArtifact(run.artifacts, "stuck-run-recovery")).length;
    const deadLetterRuns = runs.filter((run) => hasArtifact(run.artifacts, "stuck-run-dead-letter")).length;
    const replayDivergenceRuns = runs.filter((run) => replayDivergenceCount(run.artifacts) > 0).length;
    const latencies = runs.map(runLatencyMs);
    const p95LatencyMs = Math.floor(percentile(latencies, 0.95));

    summaries.push({
      workflowId,
      runCount,
      completedRuns,
      failedRuns,
      runningRuns,
      needsHumanRuns,
      recoveredRuns,
      deadLetterRuns,
      replayDivergenceRuns,
      p95LatencyMs,
      failureRate: safeRate(failedRuns, runCount),
      needsHumanRate: safeRate(needsHumanRuns, runCount),
      deadLetterRate: safeRate(deadLetterRuns, runCount)
    });
  }

  return summaries.sort((a, b) => b.runCount - a.runCount || a.workflowId.localeCompare(b.workflowId));
}

export const DEFAULT_HARBOR_RELIABILITY_ALERT_BUDGET: HarborReliabilityAlertBudget = {
  minimumRuns: 5,
  maxFailureRate: 0.1,
  maxNeedsHumanRate: 0.25,
  maxDeadLetterRate: 0.05,
  maxP95LatencyMs: 120_000
};

export function deriveReliabilityAlerts(
  summaries: HarborWorkflowReliabilitySummary[],
  budgetOverrides: Partial<HarborReliabilityAlertBudget> = {}
): HarborReliabilityAlert[] {
  const budget: HarborReliabilityAlertBudget = {
    ...DEFAULT_HARBOR_RELIABILITY_ALERT_BUDGET,
    ...budgetOverrides
  };
  const alerts: HarborReliabilityAlert[] = [];

  for (const summary of summaries) {
    if (summary.runCount < budget.minimumRuns) {
      continue;
    }

    if (summary.failureRate > budget.maxFailureRate) {
      alerts.push({
        alertId: buildAlertId(summary.workflowId, "failure_rate"),
        workflowId: summary.workflowId,
        category: "failure_rate",
        severity: alertSeverity(summary.failureRate, budget.maxFailureRate),
        message: `Failure rate ${summary.failureRate} exceeded budget ${budget.maxFailureRate}.`,
        observed: summary.failureRate,
        threshold: budget.maxFailureRate,
        runCount: summary.runCount
      });
    }

    if (summary.needsHumanRate > budget.maxNeedsHumanRate) {
      alerts.push({
        alertId: buildAlertId(summary.workflowId, "needs_human_rate"),
        workflowId: summary.workflowId,
        category: "needs_human_rate",
        severity: alertSeverity(summary.needsHumanRate, budget.maxNeedsHumanRate),
        message: `Needs-human rate ${summary.needsHumanRate} exceeded budget ${budget.maxNeedsHumanRate}.`,
        observed: summary.needsHumanRate,
        threshold: budget.maxNeedsHumanRate,
        runCount: summary.runCount
      });
    }

    if (summary.deadLetterRate > budget.maxDeadLetterRate) {
      alerts.push({
        alertId: buildAlertId(summary.workflowId, "dead_letter_rate"),
        workflowId: summary.workflowId,
        category: "dead_letter_rate",
        severity: alertSeverity(summary.deadLetterRate, budget.maxDeadLetterRate),
        message: `Dead-letter rate ${summary.deadLetterRate} exceeded budget ${budget.maxDeadLetterRate}.`,
        observed: summary.deadLetterRate,
        threshold: budget.maxDeadLetterRate,
        runCount: summary.runCount
      });
    }

    if (summary.p95LatencyMs > budget.maxP95LatencyMs) {
      alerts.push({
        alertId: buildAlertId(summary.workflowId, "latency_p95"),
        workflowId: summary.workflowId,
        category: "latency_p95",
        severity: alertSeverity(summary.p95LatencyMs, budget.maxP95LatencyMs),
        message: `P95 latency ${summary.p95LatencyMs}ms exceeded budget ${budget.maxP95LatencyMs}ms.`,
        observed: summary.p95LatencyMs,
        threshold: budget.maxP95LatencyMs,
        runCount: summary.runCount
      });
    }
  }

  return alerts;
}

export function createReliabilityAlertHookPayload(
  summaries: HarborWorkflowReliabilitySummary[],
  budgetOverrides: Partial<HarborReliabilityAlertBudget> = {},
  generatedAt: string = new Date().toISOString()
): HarborReliabilityAlertHookPayload {
  const budget: HarborReliabilityAlertBudget = {
    ...DEFAULT_HARBOR_RELIABILITY_ALERT_BUDGET,
    ...budgetOverrides
  };
  const alerts = deriveReliabilityAlerts(summaries, budget);

  return {
    generatedAt,
    budget,
    alertCount: alerts.length,
    alerts
  };
}

export function createRunTracer(serviceName = "harbor-engine"): HarborRunTracer {
  return new OtelRunTracer(serviceName);
}
