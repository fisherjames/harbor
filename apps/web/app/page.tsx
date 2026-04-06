import Link from "next/link";
import { headers } from "next/headers";
import { createServerCaller } from "@/src/server/caller";
import { sampleWorkflow } from "@/src/lib/sample-workflow";
import { openWorkflowBuilderAction, runOnboardingTemplateAction, runSampleWorkflowAction } from "./actions";
import type { RunDetail, RunSummary } from "@harbor/api";
import {
  createReliabilityAlertHookPayload,
  deriveMemoryTrustMetricsFromArtifacts,
  deriveRunHealthFacets,
  deriveWorkflowReliabilitySummaries
} from "@harbor/observability";

function resolveStaleAfterSeconds(): number {
  const parsed = Number(process.env.HARBOR_STUCK_RUN_STALE_AFTER_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 900;
  }

  return Math.floor(parsed);
}

export default async function HomePage() {
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });
  const saveResult = await caller.saveWorkflow({ workflow: sampleWorkflow });
  const runs = (await caller.listRuns({ limit: 20 })) as RunSummary[];
  const runDetails = (
    await Promise.all(
      runs.map(async (run) => {
        const detail = await caller.getRun({ runId: run.runId });
        return detail;
      })
    )
  ).filter((run): run is RunDetail => run !== null);
  const runHealthObservations = runDetails.map((run) => ({
    runId: run.runId,
    workflowId: run.workflowId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    stages: run.stages.map((stage) => ({
      startedAt: stage.startedAt,
      completedAt: stage.completedAt
    })),
    artifacts: run.artifacts
  }));
  const runHealthFacets = deriveRunHealthFacets(runHealthObservations, {
    staleAfterSeconds: resolveStaleAfterSeconds()
  });
  const workflowReliabilitySummaries = deriveWorkflowReliabilitySummaries(runHealthObservations);
  const reliabilityAlertHookPayload = createReliabilityAlertHookPayload(workflowReliabilitySummaries);
  const memoryExplorerRows = runDetails.map((run) => {
    const metrics = deriveMemoryTrustMetricsFromArtifacts(run.artifacts);
    return {
      runId: run.runId,
      workflowId: run.workflowId,
      memoryReads: metrics.memoryReadCount,
      conflictRate: metrics.conflictRate,
      droppedMemoryCount: metrics.latestDroppedMemoryCount
    };
  });

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system", maxWidth: 1100 }}>
      <h1>Harbor</h1>
      <p>Harness-first agent orchestration platform</p>
      <section style={{ marginTop: 12, border: "1px solid #dbe3ef", borderRadius: 12, padding: 14 }}>
        <h2>Guided Onboarding</h2>
        <p>Run a harness-safe starter template end-to-end in one click.</p>
        <form action={runOnboardingTemplateAction}>
          <button type="submit" style={{ padding: "8px 14px" }}>
            Run Onboarding Template
          </button>
        </form>
      </section>
      <section>
        <h2>Typed tRPC Save Result</h2>
        <p>Workflow: {saveResult.workflowId}</p>
        <p>Blocked: {String(saveResult.blocked)}</p>
        <p>Findings: {saveResult.lintFindings.length}</p>
        <form action={openWorkflowBuilderAction}>
          <button type="submit" style={{ padding: "8px 14px" }}>
            Open workflow builder
          </button>
        </form>
      </section>
      <section style={{ marginTop: 24 }}>
        <h2>Run Workflow</h2>
        <form action={runSampleWorkflowAction} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            name="prompt"
            placeholder="Enter task input"
            defaultValue="Demo workflow run"
            style={{ minWidth: 280, padding: 8 }}
          />
          <button type="submit" style={{ padding: "8px 14px" }}>
            Start Run
          </button>
        </form>
      </section>
      <section style={{ marginTop: 24 }}>
        <h2>Runs Dashboard</h2>
        {runs.length === 0 ? (
          <p>No runs yet. Start one with the form above.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>Run</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Workflow
                </th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>Status</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>Tokens</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Cost (USD)
                </th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td style={{ padding: "8px 4px" }}>
                    <Link href={`/runs/${run.runId}`}>{run.runId}</Link>
                  </td>
                  <td style={{ padding: "8px 4px" }}>{run.workflowId}</td>
                  <td style={{ padding: "8px 4px" }}>{run.status}</td>
                  <td style={{ padding: "8px 4px" }}>{run.tokenUsage.totalTokens}</td>
                  <td style={{ padding: "8px 4px" }}>{run.tokenUsage.estimatedCostUsd.toFixed(6)}</td>
                  <td style={{ padding: "8px 4px" }}>{new Date(run.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section style={{ marginTop: 24 }}>
        <h2>Run Health Facets</h2>
        <p>
          Total: {runHealthFacets.totalRuns} | Queued: {runHealthFacets.queuedRuns} | Running:{" "}
          {runHealthFacets.runningRuns} | Stuck: {runHealthFacets.stuckRuns}
        </p>
        <p>
          Needs human: {runHealthFacets.needsHumanRuns} | Failed: {runHealthFacets.failedRuns} | Completed:{" "}
          {runHealthFacets.completedRuns}
        </p>
        <p>
          Recovered: {runHealthFacets.recoveredRuns} | Dead-letter: {runHealthFacets.deadLetterRuns}
        </p>
        <p>
          Replay parent: {runHealthFacets.replayParentRuns} | Replay child: {runHealthFacets.replayChildRuns}
        </p>
        <p>
          Replay parity baseline: {runHealthFacets.replayParityBaselineRuns} | Replay divergence:{" "}
          {runHealthFacets.replayDivergenceRuns} | Replay manifest missing:{" "}
          {runHealthFacets.replayMissingManifestRuns}
        </p>
      </section>
      <section style={{ marginTop: 24 }}>
        <h2>Workflow Reliability</h2>
        {workflowReliabilitySummaries.length === 0 ? (
          <p>No workflow reliability data yet.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>Workflow</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>Runs</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>P95 ms</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Failure rate
                </th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Needs-human rate
                </th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Dead-letter rate
                </th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Failure taxonomy
                </th>
              </tr>
            </thead>
            <tbody>
              {workflowReliabilitySummaries.map((summary) => (
                <tr key={summary.workflowId}>
                  <td style={{ padding: "8px 4px" }}>{summary.workflowId}</td>
                  <td style={{ padding: "8px 4px" }}>{summary.runCount}</td>
                  <td style={{ padding: "8px 4px" }}>{summary.p95LatencyMs}</td>
                  <td style={{ padding: "8px 4px" }}>{summary.failureRate}</td>
                  <td style={{ padding: "8px 4px" }}>{summary.needsHumanRate}</td>
                  <td style={{ padding: "8px 4px" }}>{summary.deadLetterRate}</td>
                  <td style={{ padding: "8px 4px" }}>
                    failed={summary.failedRuns}, needs_human={summary.needsHumanRuns}, dead_letter=
                    {summary.deadLetterRuns}, replay_divergence={summary.replayDivergenceRuns}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section style={{ marginTop: 24 }}>
        <h2>Reliability Budget Alerts</h2>
        <p>Active alerts: {reliabilityAlertHookPayload.alertCount}</p>
        {reliabilityAlertHookPayload.alerts.length === 0 ? (
          <p>No reliability budget breaches detected.</p>
        ) : (
          <ul>
            {reliabilityAlertHookPayload.alerts.map((alert) => (
              <li key={alert.alertId}>
                [{alert.severity}] {alert.workflowId} {alert.category}: {alert.message}
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary>Alert Hook Payload</summary>
          <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 10 }}>
            {JSON.stringify(reliabilityAlertHookPayload, null, 2)}
          </pre>
        </details>
      </section>
      <section style={{ marginTop: 24 }}>
        <h2>Memory Explorer Snapshot</h2>
        {memoryExplorerRows.length === 0 ? (
          <p>No memory activity captured yet.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>Run</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>Workflow</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Memory reads
                </th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Conflict rate
                </th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "8px 4px" }}>
                  Dropped memory
                </th>
              </tr>
            </thead>
            <tbody>
              {memoryExplorerRows.map((row) => (
                <tr key={row.runId}>
                  <td style={{ padding: "8px 4px" }}>
                    <Link href={`/runs/${row.runId}`}>{row.runId}</Link>
                  </td>
                  <td style={{ padding: "8px 4px" }}>{row.workflowId}</td>
                  <td style={{ padding: "8px 4px" }}>{row.memoryReads}</td>
                  <td style={{ padding: "8px 4px" }}>{row.conflictRate}</td>
                  <td style={{ padding: "8px 4px" }}>{row.droppedMemoryCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
