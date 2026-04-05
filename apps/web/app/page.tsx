import { headers } from "next/headers";
import { createServerCaller } from "@/src/server/caller";
import { sampleWorkflow } from "@/src/lib/sample-workflow";

export default async function HomePage() {
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });
  const saveResult = await caller.saveWorkflow({ workflow: sampleWorkflow });

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system" }}>
      <h1>Harbor</h1>
      <p>Harness-first agent orchestration platform</p>
      <section>
        <h2>Typed tRPC Save Result</h2>
        <p>Workflow: {saveResult.workflowId}</p>
        <p>Blocked: {String(saveResult.blocked)}</p>
        <p>Findings: {saveResult.lintFindings.length}</p>
      </section>
    </main>
  );
}
