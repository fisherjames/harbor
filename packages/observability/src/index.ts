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

export function createRunTracer(serviceName = "harbor-engine"): HarborRunTracer {
  return new OtelRunTracer(serviceName);
}
