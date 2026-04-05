import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorktreeBoundRunIsolationManager,
  normalizePathSegment,
  resolveObservabilityTtlMs
} from "../src/index.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

const runContext = {
  request: {
    tenantId: "tenant/a",
    workspaceId: "workspace:b",
    workflowId: "wf_1",
    trigger: "manual" as const,
    input: {},
    actorId: "user"
  },
  workflow: {
    id: "wf_1",
    name: "Demo",
    version: 1,
    objective: "obj",
    systemPrompt: "sys",
    memoryPolicy: {
      retrievalMode: "monitor" as const,
      maxContextItems: 4,
      writebackEnabled: true,
      piiRetention: "redacted" as const
    },
    nodes: [
      { id: "plan", type: "planner" as const, owner: "ops", timeoutMs: 10, retryLimit: 0 },
      { id: "execute", type: "executor" as const, owner: "ops", timeoutMs: 10, retryLimit: 0 },
      { id: "verify", type: "verifier" as const, owner: "ops", timeoutMs: 10, retryLimit: 0 }
    ]
  },
  runId: "run/id"
};

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) {
      continue;
    }

    await rm(root, { recursive: true, force: true });
  }
});

describe("run isolation manager", () => {
  it("normalizes unsafe path segments", () => {
    expect(normalizePathSegment("tenant/a:workspace b")).toBe("tenant_a_workspace_b");
  });

  it("resolves observability ttl from explicit options", () => {
    expect(resolveObservabilityTtlMs(60_000)).toBe(60_000);
    expect(resolveObservabilityTtlMs(0)).toBe(DEFAULT_TTL_MS);
    expect(resolveObservabilityTtlMs(-1)).toBe(DEFAULT_TTL_MS);
  });

  it("resolves observability ttl from env with safe fallback", () => {
    expect(resolveObservabilityTtlMs()).toBe(DEFAULT_TTL_MS);

    vi.stubEnv("HARBOR_OBSERVABILITY_SESSION_TTL_MS", "not-a-number");
    expect(resolveObservabilityTtlMs()).toBe(DEFAULT_TTL_MS);

    vi.stubEnv("HARBOR_OBSERVABILITY_SESSION_TTL_MS", "0");
    expect(resolveObservabilityTtlMs()).toBe(DEFAULT_TTL_MS);

    vi.stubEnv("HARBOR_OBSERVABILITY_SESSION_TTL_MS", "120000");
    expect(resolveObservabilityTtlMs()).toBe(120_000);
  });

  it("creates a run-scoped worktree and tears it down", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-isolation-"));
    tempRoots.push(root);

    const now = () => new Date("2026-04-05T00:00:00.000Z");
    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      observabilityTtlMs: 60_000,
      now
    });

    const session = await manager.setup(runContext);

    expect(session.worktreePath.startsWith(root)).toBe(true);
    await expect(access(session.worktreePath)).resolves.toBeUndefined();
    expect(session.observabilitySessionId).toBe("obs_run_id_1775347200000");
    expect(session.observabilityExpiresAt).toBe("2026-04-05T00:01:00.000Z");
    expect(session.metadata?.ttlMs).toBe(60_000);

    await manager.teardown(runContext, session, "completed");
    await expect(access(session.worktreePath)).rejects.toThrow();
  });

  it("uses env root and env exporter metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-isolation-env-"));
    tempRoots.push(root);

    vi.stubEnv("HARBOR_RUN_WORKTREE_ROOT", root);
    vi.stubEnv("HARBOR_OBSERVABILITY_SESSION_TTL_MS", "120000");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel.local");

    const manager = createWorktreeBoundRunIsolationManager({
      now: () => new Date("2026-04-05T01:00:00.000Z")
    });

    const session = await manager.setup(runContext);

    expect(session.worktreePath.startsWith(root)).toBe(true);
    expect(session.observabilityExpiresAt).toBe("2026-04-05T01:02:00.000Z");
    expect(session.metadata?.exporterEndpoint).toBe("http://otel.local");

    await manager.teardown(runContext, session, "failed");
    await expect(access(session.worktreePath)).rejects.toThrow();
  });

  it("uses default clock when no now override is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-isolation-default-clock-"));
    tempRoots.push(root);

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      observabilityTtlMs: 5_000
    });

    const session = await manager.setup(runContext);

    expect(session.observabilitySessionId.startsWith("obs_run_id_")).toBe(true);
    expect(session.metadata?.ttlMs).toBe(5_000);

    await manager.teardown(runContext, session, "completed");
    await expect(access(session.worktreePath)).rejects.toThrow();
  });

  it("allows idempotent teardown for already-removed worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-isolation-idempotent-"));
    tempRoots.push(root);

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      now: () => new Date("2026-04-05T02:00:00.000Z")
    });

    const session = await manager.setup(runContext);
    await manager.teardown(runContext, session, "completed");
    await manager.teardown(runContext, session, "completed");

    await expect(access(session.worktreePath)).rejects.toThrow();
  });
});
