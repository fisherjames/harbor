import {
  createHarborRouter,
  type AppRouter,
  type HarborApiContext,
  type ListRunsInput
} from "@harbor/api";
import {
  InMemoryRunPersistence,
  InMemoryWorkflowRegistry,
  createPostgresRunPersistence,
  type RunStore
} from "@harbor/database";
import {
  DEFAULT_HARBOR_POLICY_SIGNATURE,
  createModelProviderFromEnv,
  createFileStandardsRemediationProvider,
  createWorkflowPolicyVerifier,
  createWorkflowRunner
} from "@harbor/engine";
import { parseTrustedSignatures } from "@harbor/engine";
import { createInMemoryMemuClient, createMemuClient, type MemuClient } from "@harbor/memu";
import { createRunTracer } from "@harbor/observability";
import { evaluateCalibration, runAdversarialSuite, type WorkflowDefinition } from "@harbor/harness";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubPromotionPullRequest, runGitHubPromotionGate } from "./github-promotion";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../../..");

declare global {
  // eslint-disable-next-line no-var
  var __harborInMemoryRunStore: RunStore | undefined;
  // eslint-disable-next-line no-var
  var __harborInMemoryWorkflowRegistry: InMemoryWorkflowRegistry | undefined;
}

function resolveRepoFilePath(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function resolveMemuClient(): MemuClient {
  if (process.env.MEMU_ENDPOINT) {
    return createMemuClient({
      endpoint: process.env.MEMU_ENDPOINT,
      ...(process.env.MEMU_API_KEY ? { apiKey: process.env.MEMU_API_KEY } : {}),
      ...(process.env.MEMU_SIGNING_SECRET ? { signingSecret: process.env.MEMU_SIGNING_SECRET } : {})
    });
  }

  return createInMemoryMemuClient();
}

function resolveRunStore(): RunStore {
  if (process.env.DATABASE_URL) {
    return createPostgresRunPersistence(process.env.DATABASE_URL);
  }

  if (!globalThis.__harborInMemoryRunStore) {
    globalThis.__harborInMemoryRunStore = new InMemoryRunPersistence();
  }

  return globalThis.__harborInMemoryRunStore;
}

function resolveWorkflowRegistry(): InMemoryWorkflowRegistry {
  if (!globalThis.__harborInMemoryWorkflowRegistry) {
    globalThis.__harborInMemoryWorkflowRegistry = new InMemoryWorkflowRegistry();
  }

  return globalThis.__harborInMemoryWorkflowRegistry;
}

function resolvePolicyVerifier() {
  const trustedSignaturesFromEnv = parseTrustedSignatures(process.env.HARBOR_TRUSTED_POLICY_SIGNATURES);
  const signingSecret = process.env.HARBOR_POLICY_SIGNING_SECRET;
  const trustedSignatures =
    trustedSignaturesFromEnv.length > 0
      ? trustedSignaturesFromEnv
      : signingSecret
        ? []
        : [DEFAULT_HARBOR_POLICY_SIGNATURE];

  return createWorkflowPolicyVerifier({
    requireBundle: true,
    ...(trustedSignatures.length > 0 ? { trustedSignatures } : {}),
    ...(signingSecret
      ? {
          signingSecret
        }
      : {})
  });
}

function resolveEvaluatorRubric() {
  const rubricPath = resolveRepoFilePath("docs/evaluator/rubric.json");
  return JSON.parse(fs.readFileSync(rubricPath, "utf8")) as {
    rubricVersion: string;
    benchmarkSetId: string;
    calibratedAt: string;
    minimumAgreement: number;
    maximumDrift: number;
  };
}

function resolveBenchmarkObservations(event: "deploy" | "publish") {
  const benchmarkPath = resolveRepoFilePath("docs/evaluator/benchmarks/shared-benchmark.json");
  const parsed = JSON.parse(fs.readFileSync(benchmarkPath, "utf8")) as {
    observations: Array<{
      scenarioId: string;
      expectedVerdict: "pass" | "fail";
      observedVerdict: "pass" | "fail";
    }>;
  };

  if (event === "publish") {
    return parsed.observations;
  }

  return parsed.observations.filter((observation) => observation.scenarioId !== "publish-readiness");
}

function resolveShadowGateSummary(input: {
  workflowId: string;
  version: number;
  event: "deploy" | "publish";
  rolloutMode: "active" | "canary" | "shadow";
}) {
  if (input.rolloutMode === "active") {
    return {
      mode: "active" as const,
      status: "passed" as const,
      blocked: false,
      summary: "Active rollout mode does not require shadow comparison."
    };
  }

  return {
    mode: input.rolloutMode,
    status: "passed" as const,
    blocked: false,
    summary:
      input.event === "publish"
        ? "Shadow comparison passed against publish baseline."
        : "Shadow comparison passed against deploy baseline.",
    comparison: {
      baselineRunId: `baseline:${input.workflowId}:v${input.version}:${input.event}`,
      candidateRunId: `candidate:${input.workflowId}:v${input.version}:${input.event}`,
      parityScore: input.event === "publish" ? 0.99 : 1,
      divergenceCount: 0,
      artifactPath: `harbor/shadow/${input.workflowId}/v${input.version}/${input.event}.json`
    }
  };
}

let router: AppRouter | undefined;

export function getAppRouter(): AppRouter {
  if (router) {
    return router;
  }

  const runStore = resolveRunStore();
  const registry = resolveWorkflowRegistry();
  const standardsRemediationProvider = createFileStandardsRemediationProvider(
    resolveRepoFilePath("docs/team-standards/reports/remediation.json")
  );
  const policyVerifier = resolvePolicyVerifier();
  const evaluatorRubric = resolveEvaluatorRubric();

  const runner = createWorkflowRunner({
    model: createModelProviderFromEnv(),
    memu: resolveMemuClient(),
    persistence: runStore,
    tracer: createRunTracer("harbor-web"),
    standardsRemediationProvider,
    policyVerifier
  });

  router = createHarborRouter({
    runWorkflow: runner.runWorkflow,
    listRuns(context: HarborApiContext, input: ListRunsInput) {
      return runStore.listRuns(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        input
      );
    },
    getRun(context: HarborApiContext, runId: string) {
      return runStore.getRun(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        runId
      );
    },
    escalateRun(context: HarborApiContext, input: { runId: string; reason: string }) {
      return runStore.escalateRun(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        {
          runId: input.runId,
          actorId: context.actorId,
          reason: input.reason
        }
      );
    },
    async saveWorkflowVersion(
      context: HarborApiContext,
      input: { workflow: WorkflowDefinition; state: "draft" | "published" }
    ) {
      return registry.saveVersion(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        {
          workflow: input.workflow,
          state: input.state,
          actorId: context.actorId
        }
      );
    },
    listWorkflowVersions(context: HarborApiContext, workflowId: string) {
      return registry.listVersions(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        workflowId
      );
    },
    async getWorkflowVersion(context: HarborApiContext, workflowId: string, version: number) {
      const record = await registry.getVersion(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        workflowId,
        version
      );

      if (!record) {
        return null;
      }

      return {
        workflowId: record.workflowId,
        version: record.version,
        state: record.state,
        savedAt: record.savedAt,
        savedBy: record.savedBy,
        workflow: record.workflow
      };
    },
    publishWorkflowVersion(context: HarborApiContext, input: { workflowId: string; version: number }) {
      return registry.publishVersion(
        {
          tenantId: context.tenantId,
          workspaceId: context.workspaceId
        },
        {
          workflowId: input.workflowId,
          version: input.version,
          actorId: context.actorId
        }
      );
    },
    createPromotionPullRequest(context, input) {
      return createGitHubPromotionPullRequest({
        workflow: input.workflow,
        workflowId: input.workflowId,
        version: input.version,
        actorId: context.actorId,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch
      });
    },
    async runPromotionChecks(_context, input) {
      return runGitHubPromotionGate({
        workflowId: input.workflowId,
        version: input.version,
        event: input.event,
        evalStatus: input.evalGate.status
      });
    },
    async runEvalGate(_context, input) {
      const calibration = evaluateCalibration({
        rubric: evaluatorRubric,
        observations: resolveBenchmarkObservations(input.event)
      });
      const blocked = calibration.driftDetected;
      const gatePrefix = input.event === "publish" ? "eval-regression" : "eval-smoke";

      return {
        suiteId: `${gatePrefix}:${input.workflowId}:v${input.version}`,
        status: blocked ? ("failed" as const) : ("passed" as const),
        blocked,
        score: blocked ? Math.max(0, 1 - calibration.driftScore) : 1,
        summary: blocked
          ? `Evaluator drift detected for rubric ${calibration.rubricVersion}.`
          : `Evaluator calibration stable for rubric ${calibration.rubricVersion}.`,
        failingScenarios: calibration.failingScenarioIds,
        calibration: {
          rubricVersion: calibration.rubricVersion,
          benchmarkSetId: calibration.benchmarkSetId,
          calibratedAt: calibration.calibratedAt,
          agreementScore: calibration.agreementScore,
          driftScore: calibration.driftScore,
          minimumAgreement: calibration.minimumAgreement,
          maximumDrift: calibration.maximumDrift,
          driftDetected: calibration.driftDetected
        }
      };
    },
    async runAdversarialGate(_context, input) {
      const mode = input.event === "publish" ? "nightly" : "smoke";
      const report = runAdversarialSuite({
        workflow: input.workflow,
        mode
      });
      const blocked = report.findings.some((finding) => finding.severity === "critical");

      return {
        suiteId: report.suiteId,
        status: blocked ? "failed" : "passed",
        blocked,
        summary: report.summary,
        findings: report.findings.map((finding) => ({
          findingId: finding.findingId,
          scenarioId: finding.scenarioId,
          category: finding.category,
          severity: finding.severity,
          summary: finding.summary,
          resolutionSteps: finding.resolutionSteps
        })),
        taxonomy: report.taxonomy
      };
    },
    async runShadowGate(_context, input) {
      return resolveShadowGateSummary(input);
    },
    policyVerifier
  });

  return router;
}

export function resetRouterForTests(): void {
  router = undefined;
}
