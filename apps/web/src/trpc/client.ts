import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@harbor/api";

export function resolveTrpcUrl(baseUrl?: string): string {
  if (!baseUrl) {
    return "/api/trpc";
  }

  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalized}/api/trpc`;
}

export function createBrowserTrpcClient(baseUrl?: string) {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: resolveTrpcUrl(baseUrl)
      })
    ]
  });
}
