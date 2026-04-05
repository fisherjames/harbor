import { createHarborRouter, type AppRouter } from "@harbor/api";
import { InMemoryRunPersistence } from "@harbor/database";
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

let router: AppRouter | undefined;

export function getAppRouter(): AppRouter {
  if (router) {
    return router;
  }

  const runner = createWorkflowRunner({
    model: new EchoModelProvider(),
    memu: resolveMemuClient(),
    persistence: new InMemoryRunPersistence(),
    tracer: createRunTracer("harbor-web")
  });

  router = createHarborRouter({
    runWorkflow: runner.runWorkflow
  });

  return router;
}

export function resetRouterForTests(): void {
  router = undefined;
}
