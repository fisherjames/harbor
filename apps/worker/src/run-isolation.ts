import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, RunIsolationManager, RunIsolationSession, RunStatus } from "@harbor/engine";

const DEFAULT_OBSERVABILITY_TTL_MS = 15 * 60 * 1000;

export interface WorktreeBoundRunIsolationOptions {
  worktreeRoot?: string;
  observabilityTtlMs?: number;
  now?: () => Date;
}

export function normalizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function resolveObservabilityTtlMs(explicitTtlMs?: number): number {
  if (explicitTtlMs !== undefined) {
    return explicitTtlMs > 0 ? explicitTtlMs : DEFAULT_OBSERVABILITY_TTL_MS;
  }

  const rawTtlMs = process.env.HARBOR_OBSERVABILITY_SESSION_TTL_MS;
  if (!rawTtlMs) {
    return DEFAULT_OBSERVABILITY_TTL_MS;
  }

  const parsedTtlMs = Number.parseInt(rawTtlMs, 10);
  if (!Number.isFinite(parsedTtlMs) || parsedTtlMs <= 0) {
    return DEFAULT_OBSERVABILITY_TTL_MS;
  }

  return parsedTtlMs;
}

export function createWorktreeBoundRunIsolationManager(
  options: WorktreeBoundRunIsolationOptions = {}
): RunIsolationManager {
  const worktreeRoot =
    options.worktreeRoot ?? process.env.HARBOR_RUN_WORKTREE_ROOT ?? join(tmpdir(), "harbor", "runs");
  const now = options.now ?? (() => new Date());
  const observabilityTtlMs = resolveObservabilityTtlMs(options.observabilityTtlMs);

  return {
    async setup(context: RunContext): Promise<RunIsolationSession> {
      const runSegment = normalizePathSegment(
        `${context.request.tenantId}-${context.request.workspaceId}-${context.runId}`
      );

      const worktreePath = join(worktreeRoot, runSegment);
      await mkdir(worktreePath, { recursive: true });

      const startedAt = now();
      const observabilitySessionId = `obs_${normalizePathSegment(context.runId)}_${startedAt.getTime()}`;
      const observabilityExpiresAt = new Date(startedAt.getTime() + observabilityTtlMs).toISOString();

      return {
        worktreePath,
        observabilitySessionId,
        observabilityExpiresAt,
        metadata: {
          ttlMs: observabilityTtlMs,
          exporterEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "local-inline",
          trigger: context.request.trigger
        }
      };
    },

    async teardown(_context: RunContext, session: RunIsolationSession, _outcome: RunStatus): Promise<void> {
      await rm(session.worktreePath, { recursive: true, force: true });
    }
  };
}
