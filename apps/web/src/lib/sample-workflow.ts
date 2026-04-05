import type { inferRouterInputs } from "@trpc/server";
import type { AppRouter } from "@harbor/api";

export type SaveWorkflowInput = inferRouterInputs<AppRouter>["saveWorkflow"];

export const sampleWorkflow: SaveWorkflowInput["workflow"] = {
  id: "wf_demo",
  name: "Demo typed workflow",
  version: 1,
  objective: "Generate, verify, and store a concise answer",
  systemPrompt: "You are Harbor runtime.",
  memoryPolicy: {
    retrievalMode: "monitor",
    maxContextItems: 6,
    writebackEnabled: true,
    piiRetention: "redacted"
  },
  nodes: [
    {
      id: "plan",
      type: "planner",
      owner: "ops",
      timeoutMs: 2_000,
      retryLimit: 1
    },
    {
      id: "execute",
      type: "executor",
      owner: "ops",
      timeoutMs: 2_000,
      retryLimit: 1
    },
    {
      id: "verify",
      type: "verifier",
      owner: "ops",
      timeoutMs: 2_000,
      retryLimit: 1
    }
  ]
};
