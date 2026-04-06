import { Inngest } from "inngest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HARBOR_POLICY_SIGNATURE,
  createModelProviderFromEnv,
  createFileStandardsRemediationProvider,
  createWorkflowPolicyVerifier,
  createWorkflowRunner,
  parseTrustedSignatures,
  type WorkflowRunRequest
} from "@harbor/engine";
import { createInMemoryMemuClient, createMemuClient, type MemuClient } from "@harbor/memu";
import { createRunTracer } from "@harbor/observability";
import {
  InMemoryRunPersistence,
  createPostgresRunPersistence,
  type StuckRunCandidate,
  type RunStore
} from "@harbor/database";
import { runAdversarialSuite, type AdversarialTaxonomySummary, type WorkflowDefinition } from "@harbor/harness";
import { createWorktreeBoundRunIsolationManager } from "./run-isolation.js";

export interface WorkflowRunRequestedEvent {
  name: "harbor/workflow.run.requested";
  data: {
    request: WorkflowRunRequest;
    workflow: WorkflowDefinition;
  };
}

export interface AdversarialNightlyFixture {
  tenantId: string;
  workspaceId: string;
  workflow: WorkflowDefinition;
}

export interface AdversarialNightlyWorkflowReport {
  tenantId: string;
  workspaceId: string;
  workflowId: string;
  workflowVersion: number;
  blocked: boolean;
  summary: string;
  findings: number;
  taxonomy: AdversarialTaxonomySummary;
}

export interface AdversarialNightlyReport {
  generatedAt: string;
  suiteId: string;
  mode: "nightly";
  workflowCount: number;
  blockedWorkflowCount: number;
  taxonomy: AdversarialTaxonomySummary;
  workflows: AdversarialNightlyWorkflowReport[];
}

export interface StuckRunRecoveryRecord {
  runId: string;
  tenantId: string;
  workspaceId: string;
  workflowId: string;
  status: "recovered" | "skipped";
  reason: string;
  detectedAt: string;
}

export interface StuckRunRecoveryReport {
  generatedAt: string;
  detectorId: string;
  staleAfterSeconds: number;
  scanned: number;
  recovered: number;
  skipped: number;
  runs: StuckRunRecoveryRecord[];
}

const memuClient: MemuClient = process.env.MEMU_ENDPOINT
  ? createMemuClient({
      endpoint: process.env.MEMU_ENDPOINT,
      ...(process.env.MEMU_API_KEY ? { apiKey: process.env.MEMU_API_KEY } : {}),
      ...(process.env.MEMU_SIGNING_SECRET ? { signingSecret: process.env.MEMU_SIGNING_SECRET } : {})
    })
  : createInMemoryMemuClient();

const persistence: RunStore = process.env.DATABASE_URL
  ? createPostgresRunPersistence(process.env.DATABASE_URL)
  : new InMemoryRunPersistence();
const tracer = createRunTracer("harbor-worker");
const runIsolation = createWorktreeBoundRunIsolationManager();
const standardsRemediationProvider = createFileStandardsRemediationProvider(
  fileURLToPath(new URL("../../../docs/team-standards/reports/remediation.json", import.meta.url))
);
const trustedSignaturesFromEnv = parseTrustedSignatures(process.env.HARBOR_TRUSTED_POLICY_SIGNATURES);
const signingSecret = process.env.HARBOR_POLICY_SIGNING_SECRET;
const trustedSignatures =
  trustedSignaturesFromEnv.length > 0
    ? trustedSignaturesFromEnv
    : signingSecret
      ? []
      : [DEFAULT_HARBOR_POLICY_SIGNATURE];
const policyVerifier = createWorkflowPolicyVerifier({
  requireBundle: true,
  ...(trustedSignatures.length > 0 ? { trustedSignatures } : {}),
  ...(signingSecret
    ? {
        signingSecret
      }
    : {})
});

const STUCK_RUN_DETECTOR_ID = "stuck-run-recovery-v1";
const STUCK_RUN_RECOVERY_ACTOR = "system:stuck-run-detector";
const DEFAULT_STALE_AFTER_SECONDS = 900;
const DEFAULT_STUCK_RUN_SCAN_LIMIT = 100;

const runner = createWorkflowRunner({
  model: createModelProviderFromEnv(),
  memu: memuClient,
  persistence,
  tracer,
  runIsolation,
  standardsRemediationProvider,
  policyVerifier,
  maxFixAttempts: 1
});

function emptyTaxonomy(): AdversarialTaxonomySummary {
  return {
    totalFindings: 0,
    criticalFindings: 0,
    warningFindings: 0,
    byCategory: {
      prompt_injection: 0,
      tool_permission_escalation: 0,
      cross_tenant_access: 0,
      memory_poisoning: 0
    },
    byScenario: {}
  };
}

function mergeTaxonomy(target: AdversarialTaxonomySummary, source: AdversarialTaxonomySummary): void {
  target.totalFindings += source.totalFindings;
  target.criticalFindings += source.criticalFindings;
  target.warningFindings += source.warningFindings;
  target.byCategory.prompt_injection += source.byCategory.prompt_injection;
  target.byCategory.tool_permission_escalation += source.byCategory.tool_permission_escalation;
  target.byCategory.cross_tenant_access += source.byCategory.cross_tenant_access;
  target.byCategory.memory_poisoning += source.byCategory.memory_poisoning;

  for (const [scenarioId, count] of Object.entries(source.byScenario)) {
    target.byScenario[scenarioId] = (target.byScenario[scenarioId] ?? 0) + count;
  }
}

function loadAdversarialNightlyFixtures(): AdversarialNightlyFixture[] {
  const fixturesPath = fileURLToPath(new URL("../../../docs/adversarial/workflows/nightly-fixtures.json", import.meta.url));
  const parsed = JSON.parse(fs.readFileSync(fixturesPath, "utf8")) as {
    fixtures?: AdversarialNightlyFixture[] | undefined;
  };

  return parsed.fixtures ?? [];
}

export function runNightlyAdversarialScan(fixtures: AdversarialNightlyFixture[] = loadAdversarialNightlyFixtures()): AdversarialNightlyReport {
  const generatedAt = new Date().toISOString();
  const workflows: AdversarialNightlyWorkflowReport[] = [];
  const taxonomy = emptyTaxonomy();

  for (const fixture of fixtures) {
    const suite = runAdversarialSuite({
      workflow: fixture.workflow,
      mode: "nightly"
    });

    mergeTaxonomy(taxonomy, suite.taxonomy);
    workflows.push({
      tenantId: fixture.tenantId,
      workspaceId: fixture.workspaceId,
      workflowId: fixture.workflow.id,
      workflowVersion: fixture.workflow.version,
      blocked: suite.blocked,
      summary: suite.summary,
      findings: suite.findings.length,
      taxonomy: suite.taxonomy
    });
  }

  const blockedWorkflowCount = workflows.filter((workflow) => workflow.blocked).length;

  return {
    generatedAt,
    suiteId: "adversarial-nightly-report-v1",
    mode: "nightly",
    workflowCount: workflows.length,
    blockedWorkflowCount,
    taxonomy,
    workflows
  };
}

function automaticRecoveryReason(candidate: StuckRunCandidate, staleAfterSeconds: number, detectedAt: string): string {
  return [
    "Automatic safe recovery triggered by stuck-run detector.",
    `Run ${candidate.runId} stayed in status=running for at least ${staleAfterSeconds} seconds.`,
    `Detected at ${detectedAt}.`
  ].join(" ");
}

export async function runStuckRunRecoveryScan(
  store: RunStore = persistence,
  input: { staleAfterSeconds?: number; limit?: number } = {}
): Promise<StuckRunRecoveryReport> {
  const staleAfterSeconds = input.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  const limit = input.limit ?? DEFAULT_STUCK_RUN_SCAN_LIMIT;
  const generatedAt = new Date().toISOString();
  const candidates = await store.listStuckRuns({
    staleAfterSeconds,
    limit
  });

  const runs: StuckRunRecoveryRecord[] = [];
  let recovered = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const reason = automaticRecoveryReason(candidate, staleAfterSeconds, generatedAt);
    const escalation = await store.escalateRun(
      {
        tenantId: candidate.tenantId,
        workspaceId: candidate.workspaceId
      },
      {
        runId: candidate.runId,
        actorId: STUCK_RUN_RECOVERY_ACTOR,
        reason
      }
    );

    if (escalation) {
      recovered += 1;
      await store.storeArtifact(
        candidate.runId,
        "stuck-run-recovery",
        JSON.stringify({
          detectorId: STUCK_RUN_DETECTOR_ID,
          staleAfterSeconds,
          detectedAt: generatedAt,
          escalatedBy: STUCK_RUN_RECOVERY_ACTOR,
          reason
        })
      );
      runs.push({
        runId: candidate.runId,
        tenantId: candidate.tenantId,
        workspaceId: candidate.workspaceId,
        workflowId: candidate.workflowId,
        status: "recovered",
        reason,
        detectedAt: generatedAt
      });
      continue;
    }

    skipped += 1;
    runs.push({
      runId: candidate.runId,
      tenantId: candidate.tenantId,
      workspaceId: candidate.workspaceId,
      workflowId: candidate.workflowId,
      status: "skipped",
      reason: "Candidate no longer eligible for escalation.",
      detectedAt: generatedAt
    });
  }

  return {
    generatedAt,
    detectorId: STUCK_RUN_DETECTOR_ID,
    staleAfterSeconds,
    scanned: candidates.length,
    recovered,
    skipped,
    runs
  };
}

export const inngest = new Inngest({ id: "harbor-worker" });

export const workflowRunRequested = inngest.createFunction(
  { id: "workflow-run-requested" },
  { event: "harbor/workflow.run.requested" },
  async ({ event }) => {
    return runner.runWorkflow(event.data.request, event.data.workflow);
  }
);

export const adversarialNightlyScheduled = inngest.createFunction(
  { id: "adversarial-nightly-scheduled" },
  { cron: "0 3 * * *" },
  async () => {
    return runNightlyAdversarialScan();
  }
);

export const stuckRunRecoveryScheduled = inngest.createFunction(
  { id: "stuck-run-recovery-scheduled" },
  { cron: "*/10 * * * *" },
  async () => {
    const staleAfterSeconds = Number(process.env.HARBOR_STUCK_RUN_STALE_AFTER_SECONDS ?? DEFAULT_STALE_AFTER_SECONDS);
    const limit = Number(process.env.HARBOR_STUCK_RUN_SCAN_LIMIT ?? DEFAULT_STUCK_RUN_SCAN_LIMIT);

    return runStuckRunRecoveryScan(persistence, { staleAfterSeconds, limit });
  }
);

export const functions = [workflowRunRequested, adversarialNightlyScheduled, stuckRunRecoveryScheduled];
