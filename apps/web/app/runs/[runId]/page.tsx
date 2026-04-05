import Link from "next/link";
import { headers } from "next/headers";
import { createServerCaller } from "@/src/server/caller";
import { escalateRunAction } from "../../actions";
import type { RunDetail } from "@harbor/api";

interface RunDetailPageProps {
  params: Promise<{
    runId: string;
  }>;
}

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { runId } = await params;
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });
  const run = (await caller.getRun({ runId })) as RunDetail;

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
