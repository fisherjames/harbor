"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createServerCaller } from "@/src/server/caller";
import { sampleWorkflow } from "@/src/lib/sample-workflow";

export async function runSampleWorkflowAction(formData: FormData): Promise<void> {
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });

  const prompt = String(formData.get("prompt") ?? "Demo workflow run");
  await caller.saveWorkflow({ workflow: sampleWorkflow });
  const run = await caller.runWorkflow({
    workflow: sampleWorkflow,
    trigger: "manual",
    input: {
      prompt
    }
  });

  revalidatePath("/");
  revalidatePath(`/runs/${run.runId}`);
  redirect(`/runs/${run.runId}`);
}

export async function openWorkflowBuilderAction(): Promise<void> {
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });

  await caller.saveWorkflow({ workflow: sampleWorkflow });

  const builderPath = `/workflows/${sampleWorkflow.id}/builder`;
  revalidatePath(builderPath);
  redirect(builderPath);
}

export async function escalateRunAction(formData: FormData): Promise<void> {
  const runId = String(formData.get("runId") ?? "");
  if (!runId) {
    return;
  }

  const reason = String(formData.get("reason") ?? "Operator escalation requested.");
  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });
  await caller.escalateRun({
    runId,
    reason
  });

  revalidatePath("/");
  revalidatePath(`/runs/${runId}`);
  redirect(`/runs/${runId}`);
}

export async function replayRunAction(formData: FormData): Promise<void> {
  const sourceRunId = String(formData.get("sourceRunId") ?? "");
  const workflowId = String(formData.get("workflowId") ?? "");
  const workflowVersion = Number(formData.get("workflowVersion") ?? 0);
  const replayReason = String(formData.get("replayReason") ?? "Recovery replay requested by operator.");

  if (!sourceRunId || !workflowId || !Number.isInteger(workflowVersion) || workflowVersion < 1) {
    return;
  }

  const requestHeaders = await headers();
  const caller = await createServerCaller({ headers: requestHeaders });
  const workflowVersionDetail = await caller.getWorkflowVersion({
    workflowId,
    version: workflowVersion
  });

  const replay = await caller.replayRun({
    sourceRunId,
    workflow: workflowVersionDetail.workflow,
    replayReason
  });

  revalidatePath("/");
  revalidatePath(`/runs/${sourceRunId}`);
  revalidatePath(`/runs/${replay.runId}`);
  redirect(`/runs/${replay.runId}`);
}
