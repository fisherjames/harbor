import Link from "next/link";
import { headers } from "next/headers";
import type { WorkflowVersionSummary } from "@harbor/api";
import type { WorkflowDefinition } from "@harbor/harness";
import { createServerCaller } from "@/src/server/caller";
import { sampleWorkflow } from "@/src/lib/sample-workflow";
import { WorkflowBuilder } from "./workflow-builder";

interface WorkflowBuilderPageProps {
  params: Promise<{
    workflowId: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function fallbackWorkflow(workflowId: string): WorkflowDefinition {
  if (workflowId === sampleWorkflow.id) {
    return sampleWorkflow;
  }

  return {
    ...sampleWorkflow,
    id: workflowId,
    name: `${workflowId} workflow`
  };
}

function latestVersion(versions: WorkflowVersionSummary[]): number | null {
  if (versions.length === 0) {
    return null;
  }

  return versions.reduce((max, version) => (version.version > max ? version.version : max), versions[0]?.version ?? 1);
}

function resolveStatusMessage(searchParams: Record<string, string | string[] | undefined>): string | null {
  const error = searchParams.error;
  if (typeof error === "string" && error.length > 0) {
    return `Error: ${decodeURIComponent(error)}`;
  }

  const blocked = searchParams.blocked === "1";
  const savedVersion = searchParams.savedVersion;
  const publishedVersion = searchParams.publishedVersion;
  const findings = typeof searchParams.findings === "string" ? Number(searchParams.findings) : null;

  if (typeof publishedVersion === "string") {
    return blocked
      ? `Saved v${savedVersion} but publish was blocked by ${findings ?? 0} critical lint finding(s).`
      : `Published workflow version v${publishedVersion}.`;
  }

  if (typeof savedVersion === "string") {
    return blocked
      ? `Saved v${savedVersion} with blocking lint findings (${findings ?? 0}).`
      : `Saved draft version v${savedVersion}.`;
  }

  return null;
}

export default async function WorkflowBuilderPage({ params, searchParams }: WorkflowBuilderPageProps) {
  const { workflowId } = await params;
  const query = await searchParams;
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });

  const versions = await caller.listWorkflowVersions({ workflowId });
  const newestVersion = latestVersion(versions);
  const versionFromQuery = typeof query.version === "string" ? Number(query.version) : null;
  const selectedVersion = versionFromQuery && Number.isFinite(versionFromQuery) ? versionFromQuery : newestVersion;

  let initialWorkflow = fallbackWorkflow(workflowId);
  if (selectedVersion) {
    try {
      const selected = await caller.getWorkflowVersion({ workflowId, version: selectedVersion });
      initialWorkflow = selected.workflow;
    } catch {
      initialWorkflow = fallbackWorkflow(workflowId);
    }
  }

  const statusMessage = resolveStatusMessage(query);

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system", maxWidth: 1280, margin: "0 auto" }}>
      <p>
        <Link href="/">Back to dashboard</Link>
      </p>
      <h1>Workflow Builder</h1>
      <p>Visual editing for typed workflow nodes, harness policy, and draft/publish lifecycle.</p>
      {statusMessage ? (
        <p
          style={{
            padding: "10px 12px",
            background: statusMessage.startsWith("Error:") ? "#fee2e2" : "#dbeafe",
            borderRadius: 10
          }}
        >
          {statusMessage}
        </p>
      ) : null}
      <WorkflowBuilder initialWorkflow={initialWorkflow} versions={versions} />
    </main>
  );
}
