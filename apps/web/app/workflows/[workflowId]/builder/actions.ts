"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { WorkflowDefinition } from "@harbor/harness";
import { createServerCaller } from "@/src/server/caller";

const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().min(1),
  objective: z.string().min(1),
  systemPrompt: z.string().min(1),
  memoryPolicy: z
    .object({
      retrievalMode: z.enum(["monitor", "reason"]),
      maxContextItems: z.number().int().min(1),
      writebackEnabled: z.boolean(),
      piiRetention: z.enum(["forbidden", "redacted", "allowed"])
    })
    .optional(),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum(["planner", "executor", "verifier", "memory_write", "tool_call"]),
        label: z.string().optional(),
        owner: z.string().min(1),
        timeoutMs: z.number().int().positive(),
        retryLimit: z.number().int().min(0),
        promptTemplate: z.string().optional(),
        toolPermissionScope: z.array(z.string()).optional()
      })
    )
    .min(1)
});

function builderPath(workflowId: string, query?: string): string {
  return `/workflows/${workflowId}/builder${query ? `?${query}` : ""}`;
}

function parseWorkflow(formData: FormData): WorkflowDefinition {
  const raw = String(formData.get("workflowJson") ?? "");
  const parsed = JSON.parse(raw) as unknown;
  return workflowSchema.parse(parsed);
}

export async function saveWorkflowDraftAction(formData: FormData): Promise<void> {
  try {
    const workflow = parseWorkflow(formData);
    const requestHeaders = await headers();
    const caller = await createServerCaller({ headers: requestHeaders });

    const saveResult = await caller.saveWorkflowVersion({
      workflow,
      state: "draft"
    });

    revalidatePath(builderPath(workflow.id));
    redirect(
      builderPath(
        workflow.id,
        `savedVersion=${saveResult.version}&blocked=${saveResult.blocked ? "1" : "0"}&findings=${saveResult.lintFindings.length}`
      )
    );
  } catch (error) {
    const fallbackWorkflowId = String(formData.get("workflowId") ?? "workflow");
    const message = error instanceof Error ? encodeURIComponent(error.message) : "Failed to save draft";
    redirect(builderPath(fallbackWorkflowId, `error=${message}`));
  }
}

export async function saveAndPublishWorkflowAction(formData: FormData): Promise<void> {
  try {
    const workflow = parseWorkflow(formData);
    const requestHeaders = await headers();
    const caller = await createServerCaller({ headers: requestHeaders });

    const saveResult = await caller.saveWorkflowVersion({
      workflow,
      state: "draft"
    });

    const publishResult = await caller.publishWorkflowVersion({
      workflowId: workflow.id,
      version: workflow.version
    });

    revalidatePath(builderPath(workflow.id));
    redirect(
      builderPath(
        workflow.id,
        `publishedVersion=${publishResult.version}&blocked=${publishResult.blocked ? "1" : "0"}&findings=${publishResult.lintFindings.length}&savedVersion=${saveResult.version}`
      )
    );
  } catch (error) {
    const fallbackWorkflowId = String(formData.get("workflowId") ?? "workflow");
    const message = error instanceof Error ? encodeURIComponent(error.message) : "Failed to publish version";
    redirect(builderPath(fallbackWorkflowId, `error=${message}`));
  }
}
