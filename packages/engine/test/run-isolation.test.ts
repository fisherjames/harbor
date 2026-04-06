import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../src/contracts/types.js";
import type { RunIsolationSession } from "../src/contracts/runtime.js";
import {
  createWorktreeBoundRunIsolationManager,
  normalizePathSegment,
  resolveGitRepositoryRoot,
  resolveObservabilityTtlMs,
  resolveRunIsolationMode,
  type RunIsolationCommandRunner
} from "../src/index.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

const runContext: RunContext = {
  request: {
    tenantId: "tenant/a",
    workspaceId: "workspace:b",
    workflowId: "wf_1",
    trigger: "manual",
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
      retrievalMode: "monitor",
      maxContextItems: 4,
      writebackEnabled: true,
      piiRetention: "redacted"
    },
    nodes: [
      { id: "plan", type: "planner", owner: "ops", timeoutMs: 10, retryLimit: 0 },
      { id: "execute", type: "executor", owner: "ops", timeoutMs: 10, retryLimit: 0 },
      { id: "verify", type: "verifier", owner: "ops", timeoutMs: 10, retryLimit: 0 }
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

describe("run isolation runtime", () => {
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

  it("resolves isolation mode using defaults, env, and explicit overrides", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(resolveRunIsolationMode()).toBe("filesystem");

    vi.stubEnv("NODE_ENV", "development");
    expect(resolveRunIsolationMode()).toBe("git-worktree");

    vi.stubEnv("HARBOR_RUN_ISOLATION_MODE", "filesystem");
    expect(resolveRunIsolationMode()).toBe("filesystem");

    vi.stubEnv("HARBOR_RUN_ISOLATION_MODE", "git-worktree");
    expect(resolveRunIsolationMode()).toBe("git-worktree");

    expect(resolveRunIsolationMode("filesystem")).toBe("filesystem");
  });

  it("resolves git repository root from command runner output", async () => {
    const runner: RunIsolationCommandRunner = async () => ({
      stdout: "/repo/root\n",
      stderr: ""
    });

    await expect(resolveGitRepositoryRoot(runner, "/repo/root/worktree")).resolves.toBe("/repo/root");
  });

  it("resolves git repository root with the default command runner", async () => {
    const gitRoot = await resolveGitRepositoryRoot(undefined, process.cwd());
    expect(gitRoot.length).toBeGreaterThan(0);
  });

  it("fails when git repository root cannot be resolved", async () => {
    const runner: RunIsolationCommandRunner = async () => ({
      stdout: "   ",
      stderr: ""
    });

    await expect(resolveGitRepositoryRoot(runner)).rejects.toThrow("Unable to resolve git repository root");
  });

  it("creates and tears down filesystem-isolated runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-"));
    tempRoots.push(root);

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "filesystem",
      observabilityTtlMs: 60_000,
      now: () => new Date("2026-04-06T00:00:00.000Z")
    });

    const session = await manager.setup(runContext);

    expect(session.worktreePath.startsWith(root)).toBe(true);
    await expect(access(session.worktreePath)).resolves.toBeUndefined();
    expect(session.metadata?.isolationMode).toBe("filesystem");
    expect(session.observabilitySessionId).toBe("obs_run_id_1775433600000");
    expect(session.observabilityExpiresAt).toBe("2026-04-06T00:01:00.000Z");

    await manager.teardown(runContext, session, "completed");
    await expect(access(session.worktreePath)).rejects.toThrow();
  });

  it("uses default worktree root and default clock when options are omitted", async () => {
    const manager = createWorktreeBoundRunIsolationManager({
      mode: "filesystem",
      observabilityTtlMs: 5_000
    });

    const session = await manager.setup(runContext);
    expect(session.worktreePath.startsWith(join(tmpdir(), "harbor", "runs"))).toBe(true);
    expect(session.observabilitySessionId.startsWith("obs_run_id_")).toBe(true);

    await manager.teardown(runContext, session, "completed");
    await expect(access(session.worktreePath)).rejects.toThrow();
  });

  it("falls back to manager mode when session metadata omits isolation mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-fallback-"));
    tempRoots.push(root);

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "filesystem"
    });

    const worktreePath = join(root, "manual-session");
    await mkdir(worktreePath, { recursive: true });
    const session: RunIsolationSession = {
      worktreePath,
      observabilitySessionId: "obs_manual",
      observabilityExpiresAt: new Date().toISOString(),
      metadata: {}
    };

    await manager.teardown(runContext, session, "completed");
    await expect(access(worktreePath)).rejects.toThrow();
  });

  it("creates and removes git worktrees in git-worktree mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-git-"));
    tempRoots.push(root);

    const commandCalls: Array<{ command: string; args: string[] }> = [];
    const commandRunner: RunIsolationCommandRunner = async (command, args) => {
      commandCalls.push({ command, args });
      if (args.includes("rev-parse")) {
        return {
          stdout: "/repo/root\n",
          stderr: ""
        };
      }

      return {
        stdout: "",
        stderr: ""
      };
    };

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "git-worktree",
      commandRunner,
      now: () => new Date("2026-04-06T01:00:00.000Z")
    });

    const session = await manager.setup(runContext);

    expect(session.metadata?.isolationMode).toBe("git-worktree");
    expect(session.metadata?.gitRoot).toBe("/repo/root");
    expect(
      commandCalls.some(
        (call) =>
          call.command === "git" &&
          call.args.join(" ").includes("worktree add --detach") &&
          call.args.includes(session.worktreePath)
      )
    ).toBe(true);

    await manager.teardown(runContext, session, "completed");
    expect(
      commandCalls.some(
        (call) =>
          call.command === "git" &&
          call.args.join(" ").includes("worktree remove --force") &&
          call.args.includes(session.worktreePath)
      )
    ).toBe(true);
  });

  it("allows idempotent git teardown when worktree is already missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-git-missing-"));
    tempRoots.push(root);

    const commandRunner: RunIsolationCommandRunner = async (_command, args) => {
      if (args.includes("rev-parse")) {
        return {
          stdout: "/repo/root\n",
          stderr: ""
        };
      }

      if (args.join(" ").includes("worktree remove --force")) {
        throw "fatal: '/tmp/missing' is not a working tree";
      }

      return {
        stdout: "",
        stderr: ""
      };
    };

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "git-worktree",
      commandRunner
    });

    const session: RunIsolationSession = {
      worktreePath: "/tmp/missing",
      observabilitySessionId: "obs",
      observabilityExpiresAt: new Date().toISOString(),
      metadata: {
        isolationMode: "git-worktree",
        gitRoot: "/repo/root"
      }
    };

    await expect(manager.teardown(runContext, session, "completed")).resolves.toBeUndefined();
  });

  it("ignores prune failures after git worktree removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-git-prune-"));
    tempRoots.push(root);

    const commandRunner: RunIsolationCommandRunner = async (_command, args) => {
      if (args.includes("rev-parse")) {
        return {
          stdout: "/repo/root\n",
          stderr: ""
        };
      }

      if (args.join(" ").includes("worktree prune")) {
        throw new Error("prune failed");
      }

      return {
        stdout: "",
        stderr: ""
      };
    };

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "git-worktree",
      commandRunner
    });

    const session: RunIsolationSession = {
      worktreePath: "/tmp/prune-failure",
      observabilitySessionId: "obs",
      observabilityExpiresAt: new Date().toISOString(),
      metadata: {
        isolationMode: "git-worktree",
        gitRoot: "/repo/root"
      }
    };

    await expect(manager.teardown(runContext, session, "completed")).resolves.toBeUndefined();
  });

  it("uses stderr text when classifying missing git worktree errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-git-stderr-"));
    tempRoots.push(root);

    const commandRunner: RunIsolationCommandRunner = async (_command, args) => {
      if (args.includes("rev-parse")) {
        return {
          stdout: "/repo/root\n",
          stderr: ""
        };
      }

      if (args.join(" ").includes("worktree remove --force")) {
        throw {
          stderr: "fatal: '/tmp/stderr' is not a working tree"
        };
      }

      return {
        stdout: "",
        stderr: ""
      };
    };

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "git-worktree",
      commandRunner
    });

    const session: RunIsolationSession = {
      worktreePath: "/tmp/stderr",
      observabilitySessionId: "obs",
      observabilityExpiresAt: new Date().toISOString(),
      metadata: {
        isolationMode: "git-worktree",
        gitRoot: "/repo/root"
      }
    };

    await expect(manager.teardown(runContext, session, "completed")).resolves.toBeUndefined();
  });

  it("fails git teardown on non-recoverable remove errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-git-fail-"));
    tempRoots.push(root);

    const commandRunner: RunIsolationCommandRunner = async (_command, args) => {
      if (args.includes("rev-parse")) {
        return {
          stdout: "/repo/root\n",
          stderr: ""
        };
      }

      if (args.join(" ").includes("worktree remove --force")) {
        throw new Error("permission denied");
      }

      return {
        stdout: "",
        stderr: ""
      };
    };

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "git-worktree",
      commandRunner
    });

    const session: RunIsolationSession = {
      worktreePath: "/tmp/missing",
      observabilitySessionId: "obs",
      observabilityExpiresAt: new Date().toISOString(),
      metadata: {
        isolationMode: "git-worktree",
        gitRoot: "/repo/root"
      }
    };

    await expect(manager.teardown(runContext, session, "completed")).rejects.toThrow("permission denied");
  });

  it("fails git teardown when remove throws an opaque object error", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-git-opaque-"));
    tempRoots.push(root);

    const commandRunner: RunIsolationCommandRunner = async (_command, args) => {
      if (args.includes("rev-parse")) {
        return {
          stdout: "/repo/root\n",
          stderr: ""
        };
      }

      if (args.join(" ").includes("worktree remove --force")) {
        throw {};
      }

      return {
        stdout: "",
        stderr: ""
      };
    };

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "git-worktree",
      commandRunner
    });

    const session: RunIsolationSession = {
      worktreePath: "/tmp/opaque-error",
      observabilitySessionId: "obs",
      observabilityExpiresAt: new Date().toISOString(),
      metadata: {
        isolationMode: "git-worktree",
        gitRoot: "/repo/root"
      }
    };

    await expect(manager.teardown(runContext, session, "completed")).rejects.toEqual({});
  });

  it("resolves git root during teardown when metadata does not include it", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-git-root-"));
    tempRoots.push(root);

    const commandCalls: Array<string> = [];
    const commandRunner: RunIsolationCommandRunner = async (_command, args) => {
      commandCalls.push(args.join(" "));
      if (args.includes("rev-parse")) {
        return {
          stdout: "/repo/root\n",
          stderr: ""
        };
      }

      return {
        stdout: "",
        stderr: ""
      };
    };

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "git-worktree",
      commandRunner
    });

    const session: RunIsolationSession = {
      worktreePath: "/tmp/run-worktree",
      observabilitySessionId: "obs",
      observabilityExpiresAt: new Date().toISOString(),
      metadata: {
        isolationMode: "git-worktree"
      }
    };

    await manager.teardown(runContext, session, "completed");
    expect(commandCalls.some((call) => call.includes("rev-parse --show-toplevel"))).toBe(true);
  });

  it("resolves git root during teardown when metadata gitRoot is blank", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-engine-isolation-git-blank-root-"));
    tempRoots.push(root);

    const commandCalls: Array<string> = [];
    const commandRunner: RunIsolationCommandRunner = async (_command, args) => {
      commandCalls.push(args.join(" "));
      if (args.includes("rev-parse")) {
        return {
          stdout: "/repo/root\n",
          stderr: ""
        };
      }

      return {
        stdout: "",
        stderr: ""
      };
    };

    const manager = createWorktreeBoundRunIsolationManager({
      worktreeRoot: root,
      mode: "git-worktree",
      commandRunner
    });

    const session: RunIsolationSession = {
      worktreePath: "/tmp/run-worktree",
      observabilitySessionId: "obs",
      observabilityExpiresAt: new Date().toISOString(),
      metadata: {
        isolationMode: "git-worktree",
        gitRoot: "   "
      }
    };

    await manager.teardown(runContext, session, "completed");
    expect(commandCalls.some((call) => call.includes("rev-parse --show-toplevel"))).toBe(true);
  });
});
