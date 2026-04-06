import http from "node:http";
import { serve } from "inngest/node";
import { functions, inngest } from "../dist/index.js";

const port = Number.parseInt(process.env.PORT ?? "8289", 10);
const servePath = process.env.INNGEST_SERVE_PATH?.trim() || "/api/inngest";
const requestedModelProvider = (process.env.HARBOR_MODEL_PROVIDER ?? "echo").trim().toLowerCase() || "echo";
const openAiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
const effectiveModelProvider = requestedModelProvider === "openai" && openAiConfigured ? "openai" : "echo";

const inngestHandler = serve({
  client: inngest,
  functions
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        service: "harbor-worker",
        servePath,
        providers: {
          model: {
            requested: requestedModelProvider,
            effective: effectiveModelProvider,
            openAiConfigured
          },
          memu: {
            endpoint: process.env.MEMU_ENDPOINT ?? null,
            configured: Boolean(process.env.MEMU_ENDPOINT?.trim())
          },
          persistence: {
            databaseConfigured: Boolean(process.env.DATABASE_URL?.trim())
          }
        }
      })
    );
    return;
  }

  if (url.pathname.startsWith(servePath)) {
    inngestHandler(request, response);
    return;
  }

  response.statusCode = 404;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      error: "Not Found",
      service: "harbor-worker",
      expectedPathPrefix: servePath
    })
  );
});

server.listen(port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`harbor-worker inngest server listening on :${port}${servePath}`);
});

const shutdownSignals = ["SIGINT", "SIGTERM"];
for (const signal of shutdownSignals) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
