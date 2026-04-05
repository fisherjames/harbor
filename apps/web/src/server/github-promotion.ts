import type { PromotionGateSummary, PromotionPullRequestResult } from "@harbor/api";
import type { WorkflowDefinition } from "@harbor/harness";

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

interface GitHubPromotionPullRequestInput {
  workflowId: string;
  version: number;
  workflow: WorkflowDefinition;
  actorId: string;
  baseBranch?: string | undefined;
  headBranch?: string | undefined;
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

interface GitHubRefResponse {
  object?: {
    sha?: string | undefined;
  } | null;
}

interface GitHubContentResponse {
  sha?: string | undefined;
}

interface GitHubPullRequestResponse {
  number?: number | undefined;
  html_url?: string | undefined;
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

function artifactPathFor(workflowId: string, version: number): string {
  return `harbor/workflows/${workflowId}/v${version}.json`;
}

function encodeGitHubPath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^[-./]+/, "")
    .replace(/[-./]+$/, "");
}

function defaultHeadBranch(workflowId: string, version: number): string {
  const safeWorkflowId = sanitizeBranchName(workflowId) || "workflow";
  return `harbor/promotion/${safeWorkflowId}-v${version}`;
}

function defaultPromotionResult(
  input: GitHubPromotionPullRequestInput,
  repository: string,
  baseBranch: string,
  headBranch: string,
  summary: string
): PromotionPullRequestResult {
  return {
    repository,
    baseBranch,
    headBranch,
    artifactPath: artifactPathFor(input.workflowId, input.version),
    status: "skipped",
    summary
  };
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

export async function createGitHubPromotionPullRequest(
  input: GitHubPromotionPullRequestInput,
  options?: GitHubPromotionOptions
): Promise<PromotionPullRequestResult> {
  const env = options?.env ?? process.env;
  const repository = env.GITHUB_PROMOTION_REPOSITORY ?? env.GITHUB_REPOSITORY ?? "local/harbor";
  const parsed = parseRepository(repository);
  const baseBranch =
    sanitizeBranchName(
      input.baseBranch ?? env.GITHUB_PROMOTION_BASE_BRANCH ?? env.GITHUB_PROMOTION_BRANCH ?? env.GITHUB_REF_NAME ?? "main"
    ) || "main";
  const headBranch = sanitizeBranchName(input.headBranch ?? defaultHeadBranch(input.workflowId, input.version)) || defaultHeadBranch(input.workflowId, input.version);

  if (!parsed) {
    return defaultPromotionResult(
      input,
      repository,
      baseBranch,
      headBranch,
      "Skipped promotion PR because repository is not configured as owner/repo."
    );
  }

  const token = env.GITHUB_TOKEN ?? "";
  if (!token) {
    return defaultPromotionResult(
      input,
      repository,
      baseBranch,
      headBranch,
      "Skipped promotion PR because GITHUB_TOKEN is not configured."
    );
  }

  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28"
  } satisfies Record<string, string>;

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const baseRefResponse = await fetchImpl(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    {
      method: "GET",
      headers
    }
  );

  if (!baseRefResponse.ok) {
    return defaultPromotionResult(
      input,
      repository,
      baseBranch,
      headBranch,
      `Skipped promotion PR because base branch lookup returned ${baseRefResponse.status}.`
    );
  }

  const baseRef = (await baseRefResponse.json()) as GitHubRefResponse;
  const baseSha = baseRef.object?.sha;
  if (!baseSha) {
    return defaultPromotionResult(
      input,
      repository,
      baseBranch,
      headBranch,
      "Skipped promotion PR because base branch SHA is missing."
    );
  }

  const createRefResponse = await fetchImpl(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ref: `refs/heads/${headBranch}`,
      sha: baseSha
    })
  });

  if (!createRefResponse.ok && createRefResponse.status !== 422) {
    return defaultPromotionResult(
      input,
      repository,
      baseBranch,
      headBranch,
      `Skipped promotion PR because head branch creation returned ${createRefResponse.status}.`
    );
  }

  const artifactPath = artifactPathFor(input.workflowId, input.version);
  const encodedArtifactPath = encodeGitHubPath(artifactPath);
  const existingFileResponse = await fetchImpl(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${encodedArtifactPath}?ref=${encodeURIComponent(headBranch)}`,
    {
      method: "GET",
      headers
    }
  );

  let existingSha: string | undefined;
  if (existingFileResponse.ok) {
    const existingContent = (await existingFileResponse.json()) as GitHubContentResponse;
    existingSha = existingContent.sha;
  } else if (existingFileResponse.status !== 404) {
    return defaultPromotionResult(
      input,
      repository,
      baseBranch,
      headBranch,
      `Skipped promotion PR because artifact lookup returned ${existingFileResponse.status}.`
    );
  }

  const artifactPayload = {
    workflowId: input.workflowId,
    version: input.version,
    actorId: input.actorId,
    exportedAt: new Date().toISOString(),
    workflow: input.workflow
  };

  const writeArtifactResponse = await fetchImpl(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${encodedArtifactPath}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `chore: promote workflow ${input.workflowId} v${input.version}`,
        content: Buffer.from(JSON.stringify(artifactPayload, null, 2), "utf8").toString("base64"),
        branch: headBranch,
        ...(existingSha ? { sha: existingSha } : {})
      })
    }
  );

  if (!writeArtifactResponse.ok) {
    return defaultPromotionResult(
      input,
      repository,
      baseBranch,
      headBranch,
      `Skipped promotion PR because artifact write returned ${writeArtifactResponse.status}.`
    );
  }

  const pullRequestResponse = await fetchImpl(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: `Promote workflow ${input.workflowId} v${input.version}`,
      head: headBranch,
      base: baseBranch,
      body: `Automated Harbor promotion for workflow \`${input.workflowId}\` version \`${input.version}\`.`
    })
  });

  if (!pullRequestResponse.ok) {
    if (pullRequestResponse.status === 422) {
      return defaultPromotionResult(
        input,
        repository,
        baseBranch,
        headBranch,
        "Skipped promotion PR because an equivalent pull request already exists."
      );
    }

    return defaultPromotionResult(
      input,
      repository,
      baseBranch,
      headBranch,
      `Skipped promotion PR because pull request creation returned ${pullRequestResponse.status}.`
    );
  }

  const pullRequest = (await pullRequestResponse.json()) as GitHubPullRequestResponse;
  return {
    repository,
    baseBranch,
    headBranch,
    artifactPath,
    status: "created",
    summary: `Created promotion pull request for ${input.workflowId}@v${input.version}.`,
    ...(pullRequest.number ? { pullRequestNumber: pullRequest.number } : {}),
    ...(pullRequest.html_url ? { pullRequestUrl: pullRequest.html_url } : {})
  };
}
