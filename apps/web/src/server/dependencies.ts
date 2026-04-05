import {
  createHarborRouter,
  type AppRouter,
  type HarborApiContext,
  type ListRunsInput
} from "@harbor/api";
import {
  InMemoryRunPersistence,
  InMemoryWorkflowRegistry,
  createPostgresRunPersistence,
  type RunStore
} from "@harbor/database";
import { createWorkflowRunner, EchoModelProvider } from "@harbor/engine";
import { createInMemoryMemuClient, createMemuClient, type MemuClient } from "@harbor/memu";
import { createRunTracer } from "@harbor/observability";
import type { WorkflowDefinition } from "@harbor/harness";
import { runGitHubPromotionGate } from "./github-promotion";

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
  const registry = new InMemoryWorkflowRegistry();

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
    },
    async saveWorkflowVersion(
      context: HarborApiContext,
      input: { workflow: WorkflowDefinition; state: "draft" | "published" }
    ) {
      return registry.saveVersion(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        {
          workflow: input.workflow,
          state: input.state,
          actorId: context.actorId
        }
      );
    },
    listWorkflowVersions(context: HarborApiContext, workflowId: string) {
      return registry.listVersions(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        workflowId
      );
    },
    async getWorkflowVersion(context: HarborApiContext, workflowId: string, version: number) {
      const record = await registry.getVersion(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        workflowId,
        version
      );

      if (!record) {
        return null;
      }

      return {
        workflowId: record.workflowId,
        version: record.version,
        state: record.state,
        savedAt: record.savedAt,
        savedBy: record.savedBy,
        workflow: record.workflow
      };
    },
    publishWorkflowVersion(context: HarborApiContext, input: { workflowId: string; version: number }) {
      return registry.publishVersion(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        {
          workflowId: input.workflowId,
          version: input.version,
          actorId: context.actorId
        }
      );
    },
    async runPromotionChecks(_context, input) {
      return runGitHubPromotionGate({
        workflowId: input.workflowId,
        version: input.version,
        event: input.event,
        evalStatus: input.evalGate.status
      });
    }
  });

  return router;
}

export function resetRouterForTests(): void {
  router = undefined;
}
