import Link from "next/link";
import { headers } from "next/headers";
import { createServerCaller } from "@/src/server/caller";
import { escalateRunAction, replayRunAction } from "../../actions";
import { deriveMemoryTrustMetricsFromArtifacts } from "@harbor/observability";
import type { CompareRunsOutput, RunSummary } from "@harbor/api";

interface RunDetailPageProps {
  params: Promise<{
    runId: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parseJsonArtifact<T>(value: string | undefined): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function queryValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
    return value[0];
  }

  return null;
}

export default async function RunDetailPage({ params, searchParams }: RunDetailPageProps) {
  const { runId } = await params;
  const query = await searchParams;
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });
  const run = await caller.getRun({ runId });

  if (!run) {
    return (
      <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system", maxWidth: 760 }}>
        <p>
          <Link href="/">Back to runs</Link>
        </p>
        <h1>Run Not Found</h1>
        <p>
          Run <code>{runId}</code> is not visible in the current tenant/workspace context.
        </p>
      </main>
    );
  }

  const workflowVersions = await caller.listWorkflowVersions({ workflowId: run.workflowId });
  const preferredReplayVersion =
    workflowVersions.find((version) => version.state === "published") ?? workflowVersions[0] ?? null;

  const replayManifest = parseJsonArtifact<Record<string, unknown>>(run.artifacts["replay-bundle-manifest"]);
  const replayTaxonomy = parseJsonArtifact<Record<string, number>>(run.artifacts["replay-divergence-taxonomy"]);
  const recoveryArtifact = parseJsonArtifact<Record<string, unknown>>(run.artifacts["stuck-run-recovery"]);
  const deadLetterArtifact = parseJsonArtifact<Record<string, unknown>>(run.artifacts["stuck-run-dead-letter"]);
  const replayDivergenceCount = replayTaxonomy
    ? Object.values(replayTaxonomy).reduce((sum, value) => sum + value, 0)
    : 0;
  const replayParityStatus = replayManifest
    ? replayDivergenceCount === 0
      ? "parity_baseline_recorded"
      : "divergence_detected"
    : "missing_replay_manifest";
  const memoryTrustMetrics = deriveMemoryTrustMetricsFromArtifacts(run.artifacts);
  const compareRunId = queryValue(query.compareRunId);
  const comparableRuns = ((await caller.listRuns({ workflowId: run.workflowId, limit: 40 })) as RunSummary[]).filter(
    (entry) => entry.runId !== run.runId
  );
  let runComparison: CompareRunsOutput | null = null;
  let runComparisonError: string | null = null;
  if (compareRunId && compareRunId !== run.runId) {
    try {
      runComparison = await caller.compareRuns({
        baseRunId: run.runId,
        candidateRunId: compareRunId
      });
    } catch (error) {
      runComparisonError = error instanceof Error ? error.message : "Failed to compare runs.";
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system", maxWidth: 1100 }}>
      <p>
        <Link href="/">Back to runs</Link>
      </p>
      <h1>Run Detail</h1>
      <p>
        <strong>Run:</strong> {run.runId}
      </p>
      <p>
        <strong>Workflow:</strong> {run.workflowId}
      </p>
      <p>
        <strong>Status:</strong> {run.status}
      </p>
      <section style={{ marginTop: 20 }}>
        <h2>Token + Cost Meter</h2>
        <p>
          Input tokens: {run.tokenUsage.inputTokens} | Output tokens: {run.tokenUsage.outputTokens} | Total tokens:{" "}
          {run.tokenUsage.totalTokens}
        </p>
        <p>Estimated cost: ${run.tokenUsage.estimatedCostUsd.toFixed(6)}</p>
      </section>
      <section style={{ marginTop: 20 }}>
        <h2>Manual Escalation</h2>
        <form action={escalateRunAction} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="hidden" name="runId" value={run.runId} />
          <input
            type="text"
            name="reason"
            placeholder="Reason for escalation"
            defaultValue="Operator requested review."
            style={{ minWidth: 320, padding: 8 }}
          />
          <button type="submit" style={{ padding: "8px 14px" }}>
            Escalate to Human
          </button>
        </form>
      </section>
      <section style={{ marginTop: 20 }}>
        <h2>Safe Replay</h2>
        {preferredReplayVersion ? (
          <form action={replayRunAction} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="hidden" name="sourceRunId" value={run.runId} />
            <input type="hidden" name="workflowId" value={run.workflowId} />
            <input type="hidden" name="workflowVersion" value={preferredReplayVersion.version} />
            <input
              type="text"
              name="replayReason"
              defaultValue="Recovery replay requested by operator."
              style={{ minWidth: 320, padding: 8 }}
            />
            <button type="submit" style={{ padding: "8px 14px" }}>
              Replay from Source Input
            </button>
            <span style={{ fontSize: 12 }}>
              Using workflow v{preferredReplayVersion.version} ({preferredReplayVersion.state})
            </span>
          </form>
        ) : (
          <p>No workflow versions are available yet for replay.</p>
        )}
        {deadLetterArtifact ? (
          <p style={{ marginTop: 8 }}>
            Dead-letter replay reference detected for this run. Recommended action:{" "}
            <code>
              {typeof deadLetterArtifact.replayReference === "object" &&
              deadLetterArtifact.replayReference &&
              "recommendedAction" in deadLetterArtifact.replayReference
                ? String((deadLetterArtifact.replayReference as { recommendedAction: unknown }).recommendedAction)
                : "replayRun"}
            </code>
          </p>
        ) : null}
      </section>
      <section style={{ marginTop: 20 }}>
        <h2>Version-aware Run Compare</h2>
        <form method="get" action={`/runs/${run.runId}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select name="compareRunId" defaultValue={compareRunId ?? ""} style={{ minWidth: 280, padding: 8 }}>
            <option value="">Select run to compare</option>
            {comparableRuns.map((candidate) => (
              <option key={candidate.runId} value={candidate.runId}>
                {candidate.runId} | {candidate.status} | {new Date(candidate.updatedAt).toLocaleString()}
              </option>
            ))}
          </select>
          <button type="submit" style={{ padding: "8px 14px" }}>
            Compare
          </button>
        </form>
        {runComparisonError ? <p style={{ color: "#b91c1c" }}>{runComparisonError}</p> : null}
        {runComparison ? (
          <div style={{ marginTop: 10 }}>
            <p>
              Base status: <strong>{runComparison.baseStatus}</strong> | Candidate status:{" "}
              <strong>{runComparison.candidateStatus}</strong> | Status changed:{" "}
              <strong>{String(runComparison.statusChanged)}</strong>
            </p>
            <p>
              Workflow versions: {runComparison.baseWorkflowVersion ?? "n/a"} →{" "}
              {runComparison.candidateWorkflowVersion ?? "n/a"} | Delta: {runComparison.workflowVersionDelta ?? 0}
            </p>
            <p>
              Token delta: {runComparison.tokenDelta.totalTokens} | Cost delta: $
              {runComparison.tokenDelta.estimatedCostUsd.toFixed(6)}
            </p>
            <p>
              Artifact diff: +{runComparison.artifactDiff.added.length} / -{runComparison.artifactDiff.removed.length} / ~
              {runComparison.artifactDiff.changed.length}
            </p>
            <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 10 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 4px" }}>Stage</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 4px" }}>Attempts</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 4px" }}>
                    Prompt changed
                  </th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 4px" }}>
                    Output changed
                  </th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 4px" }}>
                    Token delta
                  </th>
                </tr>
              </thead>
              <tbody>
                {runComparison.stageDiffs.map((diff) => (
                  <tr key={diff.stage}>
                    <td style={{ padding: "6px 4px" }}>{diff.stage}</td>
                    <td style={{ padding: "6px 4px" }}>
                      {diff.baseAttempts} → {diff.candidateAttempts}
                    </td>
                    <td style={{ padding: "6px 4px" }}>{String(diff.promptChanged)}</td>
                    <td style={{ padding: "6px 4px" }}>{String(diff.outputChanged)}</td>
                    <td style={{ padding: "6px 4px" }}>{diff.totalTokenDelta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ marginTop: 8 }}>Select a run to compare behavior and costs across versions.</p>
        )}
      </section>
      <section style={{ marginTop: 20 }}>
        <h2>Stage Timeline + Logs</h2>
        {run.stages.length === 0 ? (
          <p>No stage records available.</p>
        ) : (
          <ol>
            {run.stages.map((stage) => (
              <li key={`${stage.stage}-${stage.startedAt}`} style={{ marginBottom: 16 }}>
                <p>
                  <strong>{stage.stage}</strong> | attempts: {stage.attempts} | started:{" "}
                  {new Date(stage.startedAt).toLocaleString()} | completed:{" "}
                  {new Date(stage.completedAt).toLocaleString()}
                </p>
                <p>
                  Confidence: {typeof stage.confidence === "number" ? stage.confidence.toFixed(2) : "n/a"}
                </p>
                <details>
                  <summary>Prompt</summary>
                  <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 10 }}>{stage.prompt}</pre>
                </details>
                <details>
                  <summary>Output Log</summary>
                  <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 10 }}>{stage.output}</pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section style={{ marginTop: 20 }}>
        <h2>Replay Parity</h2>
        <p>
          <strong>Status:</strong> {replayParityStatus}
        </p>
        <p>
          <strong>Divergence count:</strong> {replayDivergenceCount}
        </p>
      </section>
      <section style={{ marginTop: 20 }}>
        <h2>Memory Trust + Conflict Metrics</h2>
        <p>
          Memory reads: {memoryTrustMetrics.memoryReadCount} (monitor: {memoryTrustMetrics.monitorReadCount}, reason:{" "}
          {memoryTrustMetrics.reasonReadCount})
        </p>
        <p>
          Conflict artifacts: {memoryTrustMetrics.stageConflictArtifactCount} | Latest conflict groups:{" "}
          {memoryTrustMetrics.latestConflictCount}
        </p>
        <p>
          Latest dropped memory items: {memoryTrustMetrics.latestDroppedMemoryCount} | Conflict rate:{" "}
          {memoryTrustMetrics.conflictRate}
        </p>
        {memoryTrustMetrics.latestDroppedMemoryIds.length > 0 ? (
          <p>Latest dropped IDs: {memoryTrustMetrics.latestDroppedMemoryIds.join(", ")}</p>
        ) : null}
      </section>
      <section style={{ marginTop: 20 }}>
        <h2>Artifacts</h2>
        {recoveryArtifact ? <p>Recovery artifact captured: stuck-run-recovery.</p> : null}
        {deadLetterArtifact ? <p>Dead-letter artifact captured: stuck-run-dead-letter.</p> : null}
        {Object.keys(run.artifacts).length === 0 ? (
          <p>No artifacts recorded.</p>
        ) : (
          <ul>
            {Object.entries(run.artifacts).map(([name, value]) => (
              <li key={name} style={{ marginBottom: 12 }}>
                <p>
                  <strong>{name}</strong>
                </p>
                <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 10 }}>
                  {String(value)}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
