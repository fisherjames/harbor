import { Inngest } from "inngest";
import { createWorkflowRunner, EchoModelProvider, type WorkflowRunRequest } from "@harbor/engine";
import { createInMemoryMemuClient, createMemuClient, type MemuClient } from "@harbor/memu";
import { createRunTracer } from "@harbor/observability";
import {
  InMemoryRunPersistence,
  createPostgresRunPersistence,
  type RunStore
} from "@harbor/database";
import type { WorkflowDefinition } from "@harbor/harness";

export interface WorkflowRunRequestedEvent {
  name: "harbor/workflow.run.requested";
  data: {
    request: WorkflowRunRequest;
    workflow: WorkflowDefinition;
  };
}

const memuClient: MemuClient = process.env.MEMU_ENDPOINT
  ? createMemuClient({
      endpoint: process.env.MEMU_ENDPOINT,
      ...(process.env.MEMU_API_KEY ? { apiKey: process.env.MEMU_API_KEY } : {}),
      ...(process.env.MEMU_SIGNING_SECRET ? { signingSecret: process.env.MEMU_SIGNING_SECRET } : {})
    })
  : createInMemoryMemuClient();

const persistence: RunStore = process.env.DATABASE_URL
  ? createPostgresRunPersistence(process.env.DATABASE_URL)
  : new InMemoryRunPersistence();
const tracer = createRunTracer("harbor-worker");

const runner = createWorkflowRunner({
  model: new EchoModelProvider(),
  memu: memuClient,
  persistence,
  tracer,
  maxFixAttempts: 1
});

export const inngest = new Inngest({ id: "harbor-worker" });

export const workflowRunRequested = inngest.createFunction(
  { id: "workflow-run-requested" },
  { event: "harbor/workflow.run.requested" },
  async ({ event }) => {
    return runner.runWorkflow(event.data.request, event.data.workflow);
  }
);

export const functions = [workflowRunRequested];
