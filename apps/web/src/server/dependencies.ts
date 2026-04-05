import {
  createHarborRouter,
  type AppRouter,
  type HarborApiContext,
  type ListRunsInput
} from "@harbor/api";
import {
  InMemoryRunPersistence,
  createPostgresRunPersistence,
  type RunStore
} from "@harbor/database";
import { createWorkflowRunner, EchoModelProvider } from "@harbor/engine";
import { createInMemoryMemuClient, createMemuClient, type MemuClient } from "@harbor/memu";
import { createRunTracer } from "@harbor/observability";

function resolveMemuClient(): MemuClient {
  if (process.env.MEMU_ENDPOINT) {
    return createMemuClient({
      endpoint: process.env.MEMU_ENDPOINT,
      ...(process.env.MEMU_API_KEY ? { apiKey: process.env.MEMU_API_KEY } : {}),
      ...(process.env.MEMU_SIGNING_SECRET ? { signingSecret: process.env.MEMU_SIGNING_SECRET } : {})
    });
  }

  return createInMemoryMemuClient();
}

function resolveRunStore(): RunStore {
  if (process.env.DATABASE_URL) {
    return createPostgresRunPersistence(process.env.DATABASE_URL);
  }

  return new InMemoryRunPersistence();
}

let router: AppRouter | undefined;

export function getAppRouter(): AppRouter {
  if (router) {
    return router;
  }

  const runStore = resolveRunStore();

  const runner = createWorkflowRunner({
    model: new EchoModelProvider(),
    memu: resolveMemuClient(),
    persistence: runStore,
    tracer: createRunTracer("harbor-web")
  });

  router = createHarborRouter({
    runWorkflow: runner.runWorkflow,
    listRuns(context: HarborApiContext, input: ListRunsInput) {
      return runStore.listRuns(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        input
      );
    },
    getRun(context: HarborApiContext, runId: string) {
      return runStore.getRun(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        runId
      );
    },
    escalateRun(context: HarborApiContext, input: { runId: string; reason: string }) {
      return runStore.escalateRun(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        {
          runId: input.runId,
          actorId: context.actorId,
          reason: input.reason
        }
      );
    }
  });

  return router;
}

export function resetRouterForTests(): void {
  router = undefined;
}
