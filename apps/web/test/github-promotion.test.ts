import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubPromotionPullRequest, runGitHubPromotionGate } from "../src/server/github-promotion";

const baseInput = {
  workflowId: "wf_1",
  version: 3,
  event: "deploy" as const
};

const workflow = {
  id: "wf_1",
  name: "Workflow",
  version: 3,
  objective: "Do work",
  systemPrompt: "You are Harbor",
  nodes: [
    {
      id: "plan",
      type: "planner" as const,
      owner: "ops",
      timeoutMs: 1_000,
      retryLimit: 1
    },
    {
      id: "verify",
      type: "verifier" as const,
      owner: "ops",
      timeoutMs: 1_000,
      retryLimit: 1
    }
  ]
};

describe("runGitHubPromotionGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips when eval gate is not passing", async () => {
    const result = await runGitHubPromotionGate(
      {
        ...baseInput,
        evalStatus: "failed"
      },
      {
        env: {}
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.blocked).toBe(false);
    expect(result.checks[0]?.summary).toContain("eval gate");
  });

  it("fails when repository format is invalid", async () => {
    const result = await runGitHubPromotionGate(
      {
        ...baseInput,
        evalStatus: "passed"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "invalid"
        }
      }
    );

    expect(result.status).toBe("failed");
    expect(result.blocked).toBe(true);
    expect(result.checks[0]?.summary).toContain("owner/repo");
  });

  it("skips when token or commit SHA is not configured", async () => {
    const result = await runGitHubPromotionGate(
      {
        ...baseInput,
        evalStatus: "passed"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_PROMOTION_BRANCH: "release",
          GITHUB_PROMOTION_PR_NUMBER: "101"
        }
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.repository).toBe("acme/harbor");
    expect(result.branch).toBe("release");
    expect(result.blocked).toBe(false);
    expect(result.pullRequestNumber).toBe(101);
    expect(result.pullRequestUrl).toBe("https://github.com/acme/harbor/pull/101");
  });

  it("fails when GitHub API returns non-ok response", async () => {
    const resultWithoutPr = await runGitHubPromotionGate(
      {
        ...baseInput,
        evalStatus: "passed"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_PROMOTION_SHA: "abc123",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl: async () => {
          return new Response("nope", {
            status: 500
          });
        }
      }
    );

    expect(resultWithoutPr.status).toBe("failed");
    expect(resultWithoutPr.checks[0]?.checkId).toBe("github/http");
    expect(resultWithoutPr.blocked).toBe(true);
    expect(resultWithoutPr.pullRequestNumber).toBeUndefined();

    const resultWithPr = await runGitHubPromotionGate(
      {
        ...baseInput,
        evalStatus: "passed"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_PROMOTION_SHA: "abc123",
          GITHUB_PROMOTION_PR_NUMBER: "17",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl: async () => {
          return new Response("nope", {
            status: 500
          });
        }
      }
    );

    expect(resultWithPr.status).toBe("failed");
    expect(resultWithPr.pullRequestNumber).toBe(17);
    expect(resultWithPr.pullRequestUrl).toBe("https://github.com/acme/harbor/pull/17");
  });

  it("fails when check runs are missing or failing", async () => {
    const undefinedChecks = await runGitHubPromotionGate(
      {
        ...baseInput,
        evalStatus: "passed"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_PROMOTION_SHA: "abc123",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl: async () => {
          return new Response(JSON.stringify({}), {
            status: 200
          });
        }
      }
    );

    expect(undefinedChecks.status).toBe("failed");
    expect(undefinedChecks.checks[0]?.checkId).toBe("github/check-run/none");

    const failingChecks = await runGitHubPromotionGate(
      {
        ...baseInput,
        evalStatus: "passed"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_PROMOTION_SHA: "abc123",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl: async () => {
          return new Response(
            JSON.stringify({
              check_runs: [
                {
                  id: 1,
                  name: "lint",
                  status: "completed",
                  conclusion: "success"
                },
                {
                  id: 2,
                  name: "eval",
                  status: "in_progress",
                  conclusion: null
                },
                {
                  id: 3,
                  name: "publish",
                  status: "completed",
                  conclusion: "failure"
                }
              ]
            }),
            {
              status: 200
            }
          );
        }
      }
    );

    expect(failingChecks.status).toBe("failed");
    expect(failingChecks.checks.some((check) => check.status === "failed")).toBe(true);
    expect(failingChecks.checks.some((check) => check.summary.includes("in_progress"))).toBe(true);
  });

  it("passes when all check runs pass and attaches pull request metadata", async () => {
    const result = await runGitHubPromotionGate(
      {
        ...baseInput,
        event: "publish",
        evalStatus: "passed"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_PROMOTION_SHA: "abc123",
          GITHUB_PROMOTION_BRANCH: "main",
          GITHUB_PROMOTION_PR_NUMBER: "42",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl: async (url, init) => {
          expect(String(url)).toContain("/repos/acme/harbor/commits/abc123/check-runs");
          expect(init?.method).toBe("GET");

          return new Response(
            JSON.stringify({
              check_runs: [
                {
                  id: 10,
                  name: "lint",
                  status: "completed",
                  conclusion: "success"
                },
                {
                  id: 11,
                  name: "eval",
                  status: "completed",
                  conclusion: "neutral"
                }
              ]
            }),
            {
              status: 200
            }
          );
        }
      }
    );

    expect(result.status).toBe("passed");
    expect(result.blocked).toBe(false);
    expect(result.pullRequestNumber).toBe(42);
    expect(result.pullRequestUrl).toBe("https://github.com/acme/harbor/pull/42");
  });

  it("uses global fetch when no fetch implementation override is provided", async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          check_runs: [
            {
              id: 22,
              name: "lint",
              status: "completed",
              conclusion: "skipped"
            }
          ]
        }),
        {
          status: 200
        }
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runGitHubPromotionGate(
      {
        ...baseInput,
        evalStatus: "passed"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_PROMOTION_SHA: "abc123",
          GITHUB_TOKEN: "secret"
        }
      }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("passed");
    expect(result.checks[0]?.status).toBe("passed");
  });
});

describe("createGitHubPromotionPullRequest", () => {
  it("skips when repository format is invalid", async () => {
    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "invalid"
        }
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("owner/repo");
  });

  it("skips when token is missing", async () => {
    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1",
        baseBranch: "release",
        headBranch: "harbor/promotion/custom"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor"
        }
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.baseBranch).toBe("release");
    expect(result.headBranch).toBe("harbor/promotion/custom");
    expect(result.summary).toContain("GITHUB_TOKEN");
  });

  it("falls back to default branch names when sanitized values are empty", async () => {
    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: "///",
        version: workflow.version,
        workflow,
        actorId: "actor_1",
        baseBranch: "///"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor"
        }
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.baseBranch).toBe("main");
    expect(result.headBranch).toContain("harbor/promotion/workflow-v");
  });

  it("skips when base branch lookup fails", async () => {
    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl: async () => new Response("nope", { status: 404 })
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("base branch lookup returned 404");
  });

  it("skips when base branch SHA is missing", async () => {
    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl: async () => new Response(JSON.stringify({ object: {} }), { status: 200 })
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("SHA is missing");
  });

  it("skips when head branch creation fails", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const target = String(url);
      if (target.includes("/git/ref/heads/")) {
        return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
      }

      return new Response("bad", { status: 500 });
    };

    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("head branch creation returned 500");
  });

  it("skips when artifact lookup fails with non-404", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
      }
      if (callCount === 2) {
        return new Response("exists", { status: 422 });
      }
      return new Response("bad", { status: 500 });
    };

    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("artifact lookup returned 500");
  });

  it("skips when artifact write fails", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
      }
      if (callCount === 2) {
        return new Response("exists", { status: 422 });
      }
      if (callCount === 3) {
        return new Response("missing", { status: 404 });
      }

      return new Response("write failed", { status: 500 });
    };

    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("artifact write returned 500");
  });

  it("skips when pull request creation returns 422", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
      }
      if (callCount === 2) {
        return new Response("exists", { status: 422 });
      }
      if (callCount === 3) {
        return new Response("missing", { status: 404 });
      }
      if (callCount === 4) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("duplicate", { status: 422 });
    };

    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("already exists");
  });

  it("skips when pull request creation returns non-422 failure", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
      }
      if (callCount === 2) {
        return new Response(JSON.stringify({ created: true }), { status: 201 });
      }
      if (callCount === 3) {
        return new Response("missing", { status: 404 });
      }
      if (callCount === 4) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("error", { status: 500 });
    };

    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl
      }
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("creation returned 500");
  });

  it("creates a pull request and includes metadata", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      callCount += 1;
      if (callCount === 1) {
        expect(String(url)).toContain("/git/ref/heads/release");
        return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
      }
      if (callCount === 2) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ created: true }), { status: 201 });
      }
      if (callCount === 3) {
        return new Response(JSON.stringify({ sha: "existing-sha" }), { status: 200 });
      }
      if (callCount === 4) {
        return new Response(JSON.stringify({ content: { sha: "new-sha" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          number: 55,
          html_url: "https://github.com/acme/harbor/pull/55"
        }),
        { status: 201 }
      );
    };

    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1",
        baseBranch: "release",
        headBranch: "harbor/promotion/wf_1-v3"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl
      }
    );

    expect(result.status).toBe("created");
    expect(result.repository).toBe("acme/harbor");
    expect(result.baseBranch).toBe("release");
    expect(result.headBranch).toBe("harbor/promotion/wf_1-v3");
    expect(result.pullRequestNumber).toBe(55);
    expect(result.pullRequestUrl).toBe("https://github.com/acme/harbor/pull/55");
  });

  it("creates a pull request without number when GitHub omits the field", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
      }
      if (callCount === 2) {
        return new Response(JSON.stringify({ created: true }), { status: 201 });
      }
      if (callCount === 3) {
        return new Response("missing", { status: 404 });
      }
      if (callCount === 4) {
        return new Response(JSON.stringify({ content: { sha: "new-sha" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          html_url: "https://github.com/acme/harbor/pull/custom"
        }),
        { status: 201 }
      );
    };

    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: workflow.id,
        version: workflow.version,
        workflow,
        actorId: "actor_1"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_TOKEN: "secret"
        },
        fetchImpl
      }
    );

    expect(result.status).toBe("created");
    expect(result.pullRequestNumber).toBeUndefined();
    expect(result.pullRequestUrl).toBe("https://github.com/acme/harbor/pull/custom");
  });

  it("uses global fetch fallback and default branch naming", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
      }
      if (callCount === 2) {
        return new Response("exists", { status: 422 });
      }
      if (callCount === 3) {
        return new Response("missing", { status: 404 });
      }
      if (callCount === 4) {
        return new Response(JSON.stringify({ content: { sha: "new-sha" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ number: 9 }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await createGitHubPromotionPullRequest(
      {
        workflowId: "wf odd",
        version: 7,
        workflow,
        actorId: "actor_1",
        headBranch: "///"
      },
      {
        env: {
          GITHUB_PROMOTION_REPOSITORY: "acme/harbor",
          GITHUB_PROMOTION_BASE_BRANCH: "main",
          GITHUB_TOKEN: "secret"
        }
      }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(result.status).toBe("created");
    expect(result.headBranch).toContain("harbor/promotion/");
    expect(result.artifactPath).toBe("harbor/workflows/wf odd/v7.json");
  });
});
