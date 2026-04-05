import type { PromotionGateSummary } from "@harbor/api";

type GateStatus = "passed" | "failed" | "skipped";

interface GitHubPromotionInput {
  workflowId: string;
  version: number;
  event: "deploy" | "publish";
  evalStatus: GateStatus;
}

interface GitHubPromotionOptions {
  env?: Partial<NodeJS.ProcessEnv>;
  fetchImpl?: typeof fetch;
}

interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | undefined;
}

interface GitHubChecksResponse {
  check_runs?: GitHubCheckRun[] | undefined;
}

interface GitHubLocation {
  owner: string;
  repo: string;
  repository: string;
  branch: string;
  sha: string;
  pullRequestNumber?: number | undefined;
}

function parseRepository(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    return null;
  }

  return { owner, repo };
}

function defaultGate(summary: string, status: GateStatus): PromotionGateSummary {
  return {
    provider: "github",
    repository: "local/harbor",
    branch: "main",
    status,
    blocked: status === "failed",
    checks: [
      {
        checkId: "github/promotion",
        status,
        summary
      }
    ]
  };
}

function resolveGitHubLocation(env: Partial<NodeJS.ProcessEnv>): GitHubLocation | null {
  const repository = env.GITHUB_PROMOTION_REPOSITORY ?? env.GITHUB_REPOSITORY ?? "local/harbor";
  const parsed = parseRepository(repository);
  if (!parsed) {
    return null;
  }

  const branch = env.GITHUB_PROMOTION_BRANCH ?? env.GITHUB_REF_NAME ?? "main";
  const sha = env.GITHUB_PROMOTION_SHA ?? env.GITHUB_SHA ?? "";
  const rawPr = env.GITHUB_PROMOTION_PR_NUMBER;
  const pullRequestNumber = rawPr ? Number.parseInt(rawPr, 10) : undefined;

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    repository,
    branch,
    sha,
    ...(Number.isFinite(pullRequestNumber) ? { pullRequestNumber } : {})
  };
}

function checkRunStatus(checkRun: GitHubCheckRun): GateStatus {
  if (checkRun.status !== "completed") {
    return "failed";
  }

  if (checkRun.conclusion === "success" || checkRun.conclusion === "neutral" || checkRun.conclusion === "skipped") {
    return "passed";
  }

  return "failed";
}

export async function runGitHubPromotionGate(
  input: GitHubPromotionInput,
  options?: GitHubPromotionOptions
): Promise<PromotionGateSummary> {
  if (input.evalStatus !== "passed") {
    return defaultGate(`Skipped GitHub checks for ${input.event}; eval gate is not passing.`, "skipped");
  }

  const env = options?.env ?? process.env;
  const location = resolveGitHubLocation(env);
  if (!location) {
    return defaultGate("GitHub repository is not configured as owner/repo.", "failed");
  }

  const token = env.GITHUB_TOKEN ?? "";
  if (!token || !location.sha) {
    return {
      provider: "github",
      repository: location.repository,
      branch: location.branch,
      status: "skipped",
      blocked: false,
      checks: [
        {
          checkId: "github/promotion",
          status: "skipped",
          summary: `Skipped GitHub checks for ${input.workflowId}@v${input.version}; token or SHA not configured.`
        }
      ],
      ...(location.pullRequestNumber
        ? {
            pullRequestNumber: location.pullRequestNumber,
            pullRequestUrl: `https://github.com/${location.repository}/pull/${location.pullRequestNumber}`
          }
        : {})
    };
  }

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(
    `https://api.github.com/repos/${location.owner}/${location.repo}/commits/${location.sha}/check-runs?per_page=100`,
    {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28"
      }
    }
  );

  if (!response.ok) {
    return {
      provider: "github",
      repository: location.repository,
      branch: location.branch,
      status: "failed",
      blocked: true,
      checks: [
        {
          checkId: "github/http",
          status: "failed",
          summary: `GitHub checks API returned ${response.status}.`
        }
      ],
      ...(location.pullRequestNumber
        ? {
            pullRequestNumber: location.pullRequestNumber,
            pullRequestUrl: `https://github.com/${location.repository}/pull/${location.pullRequestNumber}`
          }
        : {})
    };
  }

  const payload = (await response.json()) as GitHubChecksResponse;
  const checkRuns = payload.check_runs ?? [];
  const checks = checkRuns.map((checkRun) => {
    return {
      checkId: `github/check-run/${checkRun.id}`,
      status: checkRunStatus(checkRun),
      summary: `${checkRun.name}: ${checkRun.conclusion ?? checkRun.status}`
    };
  });

  const hasChecks = checks.length > 0;
  const failedChecks = checks.filter((check) => check.status === "failed");
  const failed = !hasChecks || failedChecks.length > 0;

  return {
    provider: "github",
    repository: location.repository,
    branch: location.branch,
    status: failed ? "failed" : "passed",
    blocked: failed,
    checks:
      checks.length > 0
        ? checks
        : [
            {
              checkId: "github/check-run/none",
              status: "failed",
              summary: "No GitHub check runs were found for the commit."
            }
          ],
    ...(location.pullRequestNumber
      ? {
          pullRequestNumber: location.pullRequestNumber,
          pullRequestUrl: `https://github.com/${location.repository}/pull/${location.pullRequestNumber}`
        }
      : {})
  };
}
