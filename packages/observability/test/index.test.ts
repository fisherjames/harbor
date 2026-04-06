import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HARBOR_RELIABILITY_ALERT_BUDGET,
  createReliabilityAlertHookPayload,
  createRunTracer,
  deriveMemoryTrustMetricsFromArtifacts,
  deriveReliabilityAlerts,
  deriveRunHealthFacets,
  deriveWorkflowReliabilitySummaries,
  type HarborRunHealthObservation,
  type HarborWorkflowReliabilitySummary
} from "../src/index.js";

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
});

describe("deriveMemoryTrustMetricsFromArtifacts", () => {
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

describe("deriveRunHealthFacets", () => {
  it("aggregates stuck/recovered/dead-letter/replay facets from run observations", () => {
    const now = new Date("2026-04-06T12:00:00.000Z");
    const observations: HarborRunHealthObservation[] = [
      {
        runId: "run_queued",
        workflowId: "wf_a",
        status: "queued",
        createdAt: "2026-04-06T11:59:00.000Z",
        updatedAt: "2026-04-06T11:59:00.000Z",
        artifacts: {}
      },
      {
        runId: "run_running_stuck",
        workflowId: "wf_a",
        status: "running",
        createdAt: "2026-04-06T11:20:00.000Z",
        updatedAt: "2026-04-06T11:30:00.000Z",
        artifacts: {
          "replay-divergence-taxonomy": JSON.stringify({
            stage_output_mismatch: 1
          })
        }
      },
      {
        runId: "run_running_fresh",
        workflowId: "wf_a",
        status: "running",
        createdAt: "2026-04-06T11:57:00.000Z",
        updatedAt: "2026-04-06T11:58:00.000Z",
        artifacts: {
          "replay-bundle-manifest": JSON.stringify({
            memoryReadSnapshots: []
          })
        }
      },
      {
        runId: "run_needs_human",
        workflowId: "wf_b",
        status: "needs_human",
        createdAt: "2026-04-06T11:40:00.000Z",
        updatedAt: "2026-04-06T11:50:00.000Z",
        artifacts: {
          "stuck-run-recovery": JSON.stringify({ policy: "recovery" }),
          "replay-parent-run": JSON.stringify({ replayRunId: "run_replay_1" })
        }
      },
      {
        runId: "run_failed",
        workflowId: "wf_b",
        status: "failed",
        createdAt: "2026-04-06T11:10:00.000Z",
        updatedAt: "2026-04-06T11:20:00.000Z",
        artifacts: {
          "stuck-run-dead-letter": JSON.stringify({ reason: "retry_limit_exceeded" }),
          "replay-child-run": JSON.stringify({ sourceRunId: "run_source_1" })
        }
      },
      {
        runId: "run_completed",
        workflowId: "wf_b",
        status: "completed",
        createdAt: "2026-04-06T11:00:00.000Z",
        updatedAt: "2026-04-06T11:01:00.000Z",
        artifacts: {}
      }
    ];

    const facets = deriveRunHealthFacets(observations, {
      now,
      staleAfterSeconds: 900
    });

    expect(facets.totalRuns).toBe(6);
    expect(facets.queuedRuns).toBe(1);
    expect(facets.runningRuns).toBe(2);
    expect(facets.stuckRuns).toBe(1);
    expect(facets.needsHumanRuns).toBe(1);
    expect(facets.failedRuns).toBe(1);
    expect(facets.completedRuns).toBe(1);
    expect(facets.recoveredRuns).toBe(1);
    expect(facets.deadLetterRuns).toBe(1);
    expect(facets.replayParentRuns).toBe(1);
    expect(facets.replayChildRuns).toBe(1);
    expect(facets.replayDivergenceRuns).toBe(1);
    expect(facets.replayParityBaselineRuns).toBe(1);
    expect(facets.replayMissingManifestRuns).toBe(4);
  });

  it("treats negative stale thresholds as zero-seconds stale window", () => {
    const facets = deriveRunHealthFacets(
      [
        {
          runId: "run_running",
          workflowId: "wf_a",
          status: "running",
          createdAt: "2026-04-06T11:59:59.000Z",
          updatedAt: "2026-04-06T12:00:00.000Z",
          artifacts: {
            "replay-bundle-manifest": "invalid-json"
          }
        }
      ],
      {
        now: new Date("2026-04-06T12:00:00.000Z"),
        staleAfterSeconds: -5
      }
    );

    expect(facets.runningRuns).toBe(1);
    expect(facets.stuckRuns).toBe(1);
    expect(facets.replayMissingManifestRuns).toBe(1);
  });

  it("handles observations with undefined artifact maps", () => {
    const facets = deriveRunHealthFacets(
      [
        {
          runId: "run_without_artifacts",
          workflowId: "wf_a",
          status: "completed",
          createdAt: "2026-04-06T11:00:00.000Z",
          updatedAt: "2026-04-06T11:01:00.000Z"
        }
      ],
      {
        now: new Date("2026-04-06T12:00:00.000Z")
      }
    );

    expect(facets.totalRuns).toBe(1);
    expect(facets.recoveredRuns).toBe(0);
    expect(facets.deadLetterRuns).toBe(0);
    expect(facets.replayDivergenceRuns).toBe(0);
    expect(facets.replayParityBaselineRuns).toBe(0);
    expect(facets.replayMissingManifestRuns).toBe(1);
  });

  it("uses current time when now input is not provided", () => {
    const referenceNow = new Date("2026-04-06T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(referenceNow);
    try {
      const facets = deriveRunHealthFacets([
        {
          runId: "run_running_default_now",
          workflowId: "wf_a",
          status: "running",
          createdAt: "2026-04-06T11:00:00.000Z",
          updatedAt: "2026-04-06T11:30:00.000Z"
        }
      ]);

      expect(facets.runningRuns).toBe(1);
      expect(facets.stuckRuns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deriveWorkflowReliabilitySummaries", () => {
  it("calculates per-workflow rates, dead-letter/replay counts, and p95 latency", () => {
    const observations: HarborRunHealthObservation[] = [
      {
        runId: "wf_a_1",
        workflowId: "wf_alpha",
        status: "completed",
        createdAt: "2026-04-06T10:00:00.000Z",
        updatedAt: "2026-04-06T10:02:30.000Z",
        stages: [
          {
            startedAt: "2026-04-06T10:00:00.000Z",
            completedAt: "2026-04-06T10:02:00.000Z"
          }
        ],
        artifacts: {}
      },
      {
        runId: "wf_a_2",
        workflowId: "wf_alpha",
        status: "failed",
        createdAt: "2026-04-06T10:05:00.000Z",
        updatedAt: "2026-04-06T10:06:00.000Z",
        stages: [
          {
            startedAt: "invalid-time",
            completedAt: "invalid-time"
          }
        ],
        artifacts: {
          "stuck-run-dead-letter": JSON.stringify({ reason: "non_recoverable" }),
          "replay-divergence-taxonomy": JSON.stringify({ verifier_mismatch: 2 })
        }
      },
      {
        runId: "wf_a_3",
        workflowId: "wf_alpha",
        status: "needs_human",
        createdAt: "invalid",
        updatedAt: "invalid",
        stages: [],
        artifacts: {}
      },
      {
        runId: "wf_b_1",
        workflowId: "wf_beta",
        status: "completed",
        createdAt: "2026-04-06T11:00:00.000Z",
        updatedAt: "2026-04-06T11:02:00.000Z",
        stages: [
          {
            startedAt: "2026-04-06T11:00:00.000Z",
            completedAt: "2026-04-06T11:01:00.000Z"
          }
        ],
        artifacts: {}
      },
      {
        runId: "wf_b_2",
        workflowId: "wf_beta",
        status: "running",
        createdAt: "2026-04-06T11:03:00.000Z",
        updatedAt: "2026-04-06T11:05:00.000Z",
        stages: [],
        artifacts: {
          "stuck-run-recovery": JSON.stringify({ recoveredBy: "scan" })
        }
      },
      {
        runId: "wf_c_1",
        workflowId: "wf_gamma",
        status: "completed",
        createdAt: "2026-04-06T11:06:00.000Z",
        updatedAt: "2026-04-06T11:07:00.000Z"
      }
    ];

    const summaries = deriveWorkflowReliabilitySummaries(observations);
    expect(summaries).toHaveLength(3);
    expect(summaries.map((summary) => summary.workflowId)).toEqual(["wf_alpha", "wf_beta", "wf_gamma"]);

    const alpha = summaries[0];
    expect(alpha.runCount).toBe(3);
    expect(alpha.completedRuns).toBe(1);
    expect(alpha.failedRuns).toBe(1);
    expect(alpha.runningRuns).toBe(0);
    expect(alpha.needsHumanRuns).toBe(1);
    expect(alpha.recoveredRuns).toBe(0);
    expect(alpha.deadLetterRuns).toBe(1);
    expect(alpha.replayDivergenceRuns).toBe(1);
    expect(alpha.p95LatencyMs).toBe(120000);
    expect(alpha.failureRate).toBe(0.3333);
    expect(alpha.needsHumanRate).toBe(0.3333);
    expect(alpha.deadLetterRate).toBe(0.3333);

    const beta = summaries[1];
    expect(beta.runCount).toBe(2);
    expect(beta.completedRuns).toBe(1);
    expect(beta.failedRuns).toBe(0);
    expect(beta.runningRuns).toBe(1);
    expect(beta.needsHumanRuns).toBe(0);
    expect(beta.recoveredRuns).toBe(1);
    expect(beta.deadLetterRuns).toBe(0);
    expect(beta.replayDivergenceRuns).toBe(0);
    expect(beta.p95LatencyMs).toBe(120000);
    expect(beta.failureRate).toBe(0);
    expect(beta.needsHumanRate).toBe(0);
    expect(beta.deadLetterRate).toBe(0);

    const gamma = summaries[2];
    expect(gamma.runCount).toBe(1);
    expect(gamma.completedRuns).toBe(1);
    expect(gamma.p95LatencyMs).toBe(60000);
  });

  it("sorts equal run-count workflows lexicographically by workflow id", () => {
    const summaries = deriveWorkflowReliabilitySummaries([
      {
        runId: "r1",
        workflowId: "wf_b",
        status: "completed",
        createdAt: "2026-04-06T10:00:00.000Z",
        updatedAt: "2026-04-06T10:01:00.000Z"
      },
      {
        runId: "r2",
        workflowId: "wf_a",
        status: "completed",
        createdAt: "2026-04-06T10:00:00.000Z",
        updatedAt: "2026-04-06T10:01:00.000Z"
      }
    ]);

    expect(summaries.map((summary) => summary.workflowId)).toEqual(["wf_a", "wf_b"]);
  });
});

describe("deriveReliabilityAlerts", () => {
  const highRiskSummary: HarborWorkflowReliabilitySummary = {
    workflowId: "wf_risky",
    runCount: 10,
    completedRuns: 3,
    failedRuns: 3,
    runningRuns: 1,
    needsHumanRuns: 4,
    recoveredRuns: 1,
    deadLetterRuns: 2,
    replayDivergenceRuns: 1,
    p95LatencyMs: 200000,
    failureRate: 0.3,
    needsHumanRate: 0.4,
    deadLetterRate: 0.2
  };

  it("emits warning/critical alerts for breached reliability budgets", () => {
    const alerts = deriveReliabilityAlerts([highRiskSummary], {
      minimumRuns: 5,
      maxFailureRate: 0.2,
      maxNeedsHumanRate: 0.3,
      maxDeadLetterRate: 0.1,
      maxP95LatencyMs: 150000
    });
    expect(alerts).toHaveLength(4);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alertId: "wf_risky:failure_rate",
          category: "failure_rate",
          severity: "warning"
        }),
        expect.objectContaining({
          alertId: "wf_risky:needs_human_rate",
          category: "needs_human_rate",
          severity: "warning"
        }),
        expect.objectContaining({
          alertId: "wf_risky:dead_letter_rate",
          category: "dead_letter_rate",
          severity: "critical"
        }),
        expect.objectContaining({
          alertId: "wf_risky:latency_p95",
          category: "latency_p95",
          severity: "warning"
        })
      ])
    );
  });

  it("skips alerts for workflows below minimum sample size and accepts default budget", () => {
    const alerts = deriveReliabilityAlerts(
      [
        {
          ...highRiskSummary,
          workflowId: "wf_low_volume",
          runCount: DEFAULT_HARBOR_RELIABILITY_ALERT_BUDGET.minimumRuns - 1
        }
      ],
      {}
    );

    expect(alerts).toEqual([]);
  });
});

describe("createReliabilityAlertHookPayload", () => {
  it("builds a deterministic payload with merged budget and generated alerts", () => {
    const summaries: HarborWorkflowReliabilitySummary[] = [
      {
        workflowId: "wf_alert",
        runCount: 6,
        completedRuns: 3,
        failedRuns: 2,
        runningRuns: 1,
        needsHumanRuns: 2,
        recoveredRuns: 0,
        deadLetterRuns: 1,
        replayDivergenceRuns: 1,
        p95LatencyMs: 130000,
        failureRate: 0.3333,
        needsHumanRate: 0.3333,
        deadLetterRate: 0.1667
      }
    ];
    const payload = createReliabilityAlertHookPayload(
      summaries,
      {
        minimumRuns: 5,
        maxFailureRate: 0.3,
        maxNeedsHumanRate: 0.4,
        maxDeadLetterRate: 0.2,
        maxP95LatencyMs: 120000
      },
      "2026-04-06T12:00:00.000Z"
    );

    expect(payload.generatedAt).toBe("2026-04-06T12:00:00.000Z");
    expect(payload.budget.minimumRuns).toBe(5);
    expect(payload.alertCount).toBe(2);
    expect(payload.alerts.map((alert) => alert.category)).toEqual(["failure_rate", "latency_p95"]);
  });
});
