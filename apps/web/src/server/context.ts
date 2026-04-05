import { auth } from "@clerk/nextjs/server";
import type { HarborApiContext } from "@harbor/api";

export interface TrpcContextOptions {
  request?: Request;
  headers?: Headers;
  authProvider?: () => Promise<{ userId: string | null; orgId: string | null }>;
}

export function contextFromHeaders(headers: Headers): Partial<HarborApiContext> {
  const tenantId = headers.get("x-harbor-tenant-id") ?? undefined;
  const workspaceId = headers.get("x-harbor-workspace-id") ?? undefined;
  const actorId = headers.get("x-harbor-actor-id") ?? undefined;

  return {
    ...(tenantId ? { tenantId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(actorId ? { actorId } : {})
  };
}

async function defaultAuthProvider(): Promise<{ userId: string | null; orgId: string | null }> {
  try {
    const session = await auth();
    return {
      userId: session.userId ?? null,
      orgId: session.orgId ?? null
    };
  } catch {
    return {
      userId: null,
      orgId: null
    };
  }
}

export async function createTrpcContext(options: TrpcContextOptions = {}): Promise<HarborApiContext> {
  const authProvider = options.authProvider ?? defaultAuthProvider;
  const identity = await authProvider();
  const headerSource = options.headers ?? options.request?.headers ?? new Headers();
  const headerContext = contextFromHeaders(headerSource);

  const tenantId = identity.orgId ?? headerContext.tenantId ?? (process.env.NODE_ENV !== "production" ? "dev-tenant" : "");
  const workspaceId =
    headerContext.workspaceId ??
    identity.orgId ??
    (process.env.NODE_ENV !== "production" ? "dev-workspace" : "");
  const actorId = identity.userId ?? headerContext.actorId ?? (process.env.NODE_ENV !== "production" ? "dev-user" : "");

  if (!tenantId || !workspaceId || !actorId) {
    throw new Error("Unable to establish tenancy context for tRPC request");
  }

  return {
    tenantId,
    workspaceId,
    actorId
  };
}
