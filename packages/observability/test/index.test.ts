import { describe, expect, it } from "vitest";
import { createRunTracer, deriveMemoryTrustMetricsFromArtifacts } from "../src/index.js";

describe("createRunTracer", () => {
  it("handles stage and finding events without throwing", () => {
    const tracer = createRunTracer("harbor-test");

    expect(() => {
      tracer.stageStart({ runId: "r1", workflowId: "wf", stage: "plan", message: "start", metadata: { a: 1 } });
      tracer.stageEnd({ runId: "r1", workflowId: "wf", stage: "plan", message: "end" });
      tracer.finding({ runId: "r1", workflowId: "wf", message: "warn" });
    }).not.toThrow();
  });

  it("records errors without throwing", () => {
    const tracer = createRunTracer("harbor-test");

    expect(() => {
      tracer.error({
        runId: "r1",
        workflowId: "wf",
        message: "error",
        error: new Error("boom")
      });
    }).not.toThrow();
  });

  it("derives trust/conflict metrics from replay and conflict artifacts", () => {
    const metrics = deriveMemoryTrustMetricsFromArtifacts({
      "replay-bundle-manifest": JSON.stringify({
        memoryReadSnapshots: [
          { stage: "plan", mode: "monitor" },
          { stage: "verify", mode: "reason" },
          { stage: "verify", mode: "reason" }
        ]
      }),
      "memory-conflict-stage_plan_1": JSON.stringify({
        conflicts: [{ title: "policy:sla" }],
        droppedMemoryIds: []
      }),
      "memory-conflict-stage_verify_2": JSON.stringify({
        conflicts: [{ title: "policy:refund" }],
        droppedMemoryIds: ["mem_a"]
      }),
      "memory-conflict-latest": JSON.stringify({
        conflicts: [{ title: "policy:refund" }],
        droppedMemoryIds: ["mem_a", "mem_b"]
      })
    });

    expect(metrics.memoryReadCount).toBe(3);
    expect(metrics.monitorReadCount).toBe(1);
    expect(metrics.reasonReadCount).toBe(2);
    expect(metrics.stageConflictArtifactCount).toBe(2);
    expect(metrics.latestConflictCount).toBe(1);
    expect(metrics.latestDroppedMemoryIds).toEqual(["mem_a", "mem_b"]);
    expect(metrics.latestDroppedMemoryCount).toBe(2);
    expect(metrics.conflictRate).toBeCloseTo(0.6667, 4);
  });

  it("gracefully handles missing or malformed observability artifacts", () => {
    const metrics = deriveMemoryTrustMetricsFromArtifacts({
      "replay-bundle-manifest": "{not-json",
      "memory-conflict-stage_plan_1": "{}",
      "memory-conflict-latest": JSON.stringify({
        conflicts: "invalid",
        droppedMemoryIds: ["mem_a", 2, null]
      })
    });

    expect(metrics.memoryReadCount).toBe(0);
    expect(metrics.monitorReadCount).toBe(0);
    expect(metrics.reasonReadCount).toBe(0);
    expect(metrics.stageConflictArtifactCount).toBe(1);
    expect(metrics.latestConflictCount).toBe(0);
    expect(metrics.latestDroppedMemoryIds).toEqual(["mem_a"]);
    expect(metrics.latestDroppedMemoryCount).toBe(1);
    expect(metrics.conflictRate).toBe(0);
  });

  it("ignores non-record replay snapshots and non-array dropped memory values", () => {
    const metrics = deriveMemoryTrustMetricsFromArtifacts({
      "replay-bundle-manifest": JSON.stringify({
        memoryReadSnapshots: [{ mode: "monitor" }, "bad", null]
      }),
      "memory-conflict-latest": JSON.stringify({
        conflicts: [{ title: "policy:sla" }],
        droppedMemoryIds: "invalid"
      })
    });

    expect(metrics.memoryReadCount).toBe(1);
    expect(metrics.monitorReadCount).toBe(1);
    expect(metrics.reasonReadCount).toBe(0);
    expect(metrics.stageConflictArtifactCount).toBe(0);
    expect(metrics.latestConflictCount).toBe(1);
    expect(metrics.latestDroppedMemoryIds).toEqual([]);
    expect(metrics.latestDroppedMemoryCount).toBe(0);
    expect(metrics.conflictRate).toBe(0);
  });

  it("returns zeroed metrics when manifest is missing snapshot array and latest conflict is not an object", () => {
    const metrics = deriveMemoryTrustMetricsFromArtifacts({
      "replay-bundle-manifest": JSON.stringify({
        memoryReadSnapshots: "invalid"
      }),
      "memory-conflict-latest": "not-json"
    });
    const metricsWithoutManifest = deriveMemoryTrustMetricsFromArtifacts({});

    expect(metrics.memoryReadCount).toBe(0);
    expect(metrics.monitorReadCount).toBe(0);
    expect(metrics.reasonReadCount).toBe(0);
    expect(metrics.latestConflictCount).toBe(0);
    expect(metrics.latestDroppedMemoryIds).toEqual([]);
    expect(metricsWithoutManifest.memoryReadCount).toBe(0);
    expect(metricsWithoutManifest.latestConflictCount).toBe(0);
  });
});
