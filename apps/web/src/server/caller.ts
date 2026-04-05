import type { HarborApiContext } from "@harbor/api";
import { createTrpcContext, type TrpcContextOptions } from "./context";
import { getAppRouter } from "./dependencies";

export async function createServerCaller(options: TrpcContextOptions = {}) {
  const context = await createTrpcContext(options);
  return getAppRouter().createCaller(context);
}

export async function createServerCallerWithContext(context: HarborApiContext) {
  return getAppRouter().createCaller(context);
}
