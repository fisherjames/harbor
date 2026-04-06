import Link from "next/link";
import { headers } from "next/headers";
import { createServerCaller } from "@/src/server/caller";
import { escalateRunAction } from "../../actions";
import { deriveMemoryTrustMetricsFromArtifacts } from "@harbor/observability";

interface RunDetailPageProps {
  params: Promise<{
    runId: string;
  }>;
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

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { runId } = await params;
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

  const replayManifest = parseJsonArtifact<Record<string, unknown>>(run.artifacts["replay-bundle-manifest"]);
  const replayTaxonomy = parseJsonArtifact<Record<string, number>>(run.artifacts["replay-divergence-taxonomy"]);
  const replayDivergenceCount = replayTaxonomy
    ? Object.values(replayTaxonomy).reduce((sum, value) => sum + value, 0)
    : 0;
  const replayParityStatus = replayManifest
    ? replayDivergenceCount === 0
      ? "parity_baseline_recorded"
      : "divergence_detected"
    : "missing_replay_manifest";
  const memoryTrustMetrics = deriveMemoryTrustMetricsFromArtifacts(run.artifacts);

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
