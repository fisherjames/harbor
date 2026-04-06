import Link from "next/link";
import { headers } from "next/headers";
import { createServerCaller } from "@/src/server/caller";
import { sampleWorkflow } from "@/src/lib/sample-workflow";
import { openWorkflowBuilderAction, runSampleWorkflowAction } from "./actions";
import type { RunSummary } from "@harbor/api";

export default async function HomePage() {
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });
  const saveResult = await caller.saveWorkflow({ workflow: sampleWorkflow });
  const runs = (await caller.listRuns({ limit: 20 })) as RunSummary[];

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system", maxWidth: 1100 }}>
      <h1>Harbor</h1>
      <p>Harness-first agent orchestration platform</p>
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
    </main>
  );
}
