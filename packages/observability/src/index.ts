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

export function createRunTracer(serviceName = "harbor-engine"): HarborRunTracer {
  return new OtelRunTracer(serviceName);
}
