import { afterEach, describe, expect, it, vi } from "vitest";
import { runGitHubPromotionGate } from "../src/server/github-promotion";

const baseInput = {
  workflowId: "wf_1",
  version: 3,
  event: "deploy" as const
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
