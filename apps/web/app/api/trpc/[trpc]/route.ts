import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createTrpcContext } from "@/src/server/context";
import { getAppRouter } from "@/src/server/dependencies";

export const runtime = "nodejs";

const handler = (request: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: getAppRouter(),
    createContext: () => createTrpcContext({ request })
  });

export { handler as GET, handler as POST };
