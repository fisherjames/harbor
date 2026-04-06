import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunIsolationManager, RunIsolationSession } from "../contracts/runtime.js";
import type { RunContext, RunStatus } from "../contracts/types.js";

const DEFAULT_OBSERVABILITY_TTL_MS = 15 * 60 * 1000;
const execFileAsync = promisify(execFile);

export type RunIsolationMode = "git-worktree" | "filesystem";

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
}

export type RunIsolationCommandRunner = (
  command: string,
  args: string[]
) => Promise<CommandExecutionResult>;

export interface WorktreeBoundRunIsolationOptions {
  worktreeRoot?: string;
  observabilityTtlMs?: number;
  now?: () => Date;
  mode?: RunIsolationMode;
  commandRunner?: RunIsolationCommandRunner;
}

function defaultCommandRunner(command: string, args: string[]): Promise<CommandExecutionResult> {
  return execFileAsync(command, args, {
    encoding: "utf8"
  }).then((result) => ({
    stdout: result.stdout,
    stderr: result.stderr
  }));
}

function parseCommandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const candidate = error as {
    message?: unknown;
    stderr?: unknown;
  };

  const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
  if (stderr.length > 0) {
    return stderr;
  }

  const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
  if (message.length > 0) {
    return message;
  }

  return String(error);
}

function isWorktreeMissingError(error: unknown): boolean {
  const normalized = parseCommandErrorMessage(error).toLowerCase();
  return (
    normalized.includes("not a working tree") ||
    normalized.includes("is not a working tree") ||
    normalized.includes("does not exist") ||
    normalized.includes("no such file or directory")
  );
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

export function resolveRunIsolationMode(explicitMode?: RunIsolationMode): RunIsolationMode {
  if (explicitMode) {
    return explicitMode;
  }

  const envMode = process.env.HARBOR_RUN_ISOLATION_MODE?.trim().toLowerCase();
  if (envMode === "git-worktree" || envMode === "filesystem") {
    return envMode;
  }

  return process.env.NODE_ENV === "test" ? "filesystem" : "git-worktree";
}

export async function resolveGitRepositoryRoot(
  commandRunner: RunIsolationCommandRunner = defaultCommandRunner,
  cwd: string = process.cwd()
): Promise<string> {
  const result = await commandRunner("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const gitRoot = result.stdout.trim();
  if (!gitRoot) {
    throw new Error("Unable to resolve git repository root for run isolation.");
  }

  return gitRoot;
}

function resolveSessionMode(session: RunIsolationSession, defaultMode: RunIsolationMode): RunIsolationMode {
  const sessionMode = session.metadata?.isolationMode;
  if (sessionMode === "git-worktree" || sessionMode === "filesystem") {
    return sessionMode;
  }

  return defaultMode;
}

function resolveSessionGitRoot(session: RunIsolationSession): string | null {
  const gitRoot = session.metadata?.gitRoot;
  if (typeof gitRoot !== "string") {
    return null;
  }

  const trimmed = gitRoot.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function setupGitWorktree(
  commandRunner: RunIsolationCommandRunner,
  worktreePath: string
): Promise<{ gitRoot: string }> {
  const gitRoot = await resolveGitRepositoryRoot(commandRunner);
  await commandRunner("git", ["-C", gitRoot, "worktree", "add", "--detach", worktreePath, "HEAD"]);
  return { gitRoot };
}

async function teardownGitWorktree(
  commandRunner: RunIsolationCommandRunner,
  worktreePath: string,
  gitRoot: string
): Promise<void> {
  try {
    await commandRunner("git", ["-C", gitRoot, "worktree", "remove", "--force", worktreePath]);
  } catch (error) {
    if (!isWorktreeMissingError(error)) {
      throw error;
    }
  }

  await rm(worktreePath, { recursive: true, force: true });

  try {
    await commandRunner("git", ["-C", gitRoot, "worktree", "prune"]);
  } catch {
    // No-op: pruning is best-effort.
  }
}

export function createWorktreeBoundRunIsolationManager(
  options: WorktreeBoundRunIsolationOptions = {}
): RunIsolationManager {
  const worktreeRoot =
    options.worktreeRoot ?? process.env.HARBOR_RUN_WORKTREE_ROOT ?? join(tmpdir(), "harbor", "runs");
  const now = options.now ?? (() => new Date());
  const observabilityTtlMs = resolveObservabilityTtlMs(options.observabilityTtlMs);
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const mode = resolveRunIsolationMode(options.mode);

  return {
    async setup(context: RunContext): Promise<RunIsolationSession> {
      await mkdir(worktreeRoot, { recursive: true });

      const runSegment = normalizePathSegment(
        `${context.request.tenantId}-${context.request.workspaceId}-${context.runId}`
      );
      const worktreePath = join(worktreeRoot, runSegment);
      await rm(worktreePath, { recursive: true, force: true });

      const metadata: Record<string, unknown> = {
        ttlMs: observabilityTtlMs,
        exporterEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "local-inline",
        trigger: context.request.trigger,
        isolationMode: mode
      };

      if (mode === "git-worktree") {
        const { gitRoot } = await setupGitWorktree(commandRunner, worktreePath);
        metadata.gitRoot = gitRoot;
        metadata.gitRef = "HEAD";
      } else {
        await mkdir(worktreePath, { recursive: true });
      }

      const startedAt = now();
      const observabilitySessionId = `obs_${normalizePathSegment(context.runId)}_${startedAt.getTime()}`;
      const observabilityExpiresAt = new Date(startedAt.getTime() + observabilityTtlMs).toISOString();

      return {
        worktreePath,
        observabilitySessionId,
        observabilityExpiresAt,
        metadata
      };
    },

    async teardown(_context: RunContext, session: RunIsolationSession, _outcome: RunStatus): Promise<void> {
      const sessionMode = resolveSessionMode(session, mode);
      if (sessionMode === "git-worktree") {
        const gitRoot = resolveSessionGitRoot(session) ?? (await resolveGitRepositoryRoot(commandRunner));
        await teardownGitWorktree(commandRunner, session.worktreePath, gitRoot);
        return;
      }

      await rm(session.worktreePath, { recursive: true, force: true });
    }
  };
}
