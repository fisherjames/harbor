import { Inngest } from "inngest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HARBOR_POLICY_SIGNATURE,
  createModelProviderFromEnv,
  createWorktreeBoundRunIsolationManager,
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
  status: "recovered" | "dead_letter" | "skipped";
  reason: string;
  detectedAt: string;
}

export interface StuckRunRecoveryScopePolicy {
  tenantId: string;
  workspaceId: string;
  staleAfterSeconds: number;
  limit: number;
  enabled: boolean;
}

export interface StuckRunRecoveryReport {
  generatedAt: string;
  detectorId: string;
  staleAfterSeconds: number;
  scanned: number;
  recovered: number;
  deadLettered: number;
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
const DEFAULT_SCOPE_POLICY_ENABLED = true;
const DEAD_LETTER_ACTION = "replayRun";

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

function automaticDeadLetterReason(candidate: StuckRunCandidate, staleAfterSeconds: number, detectedAt: string): string {
  return [
    "Automatic dead-letter fallback triggered by stuck-run detector.",
    `Run ${candidate.runId} could not be escalated after remaining in status=running for at least ${staleAfterSeconds} seconds.`,
    `Detected at ${detectedAt}.`
  ].join(" ");
}

function parsePositiveInt(raw: string | undefined, fallback: number, minimum: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return parsed;
}

function asScopeToken(value: unknown): string {
  if (typeof value !== "string") {
    return "*";
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "*";
}

function asScopePositiveInt(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  return rounded >= minimum ? rounded : fallback;
}

export function resolveStuckRunRecoveryPolicies(
  raw: string | undefined,
  defaults: {
    staleAfterSeconds: number;
    limit: number;
  } = {
    staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
    limit: DEFAULT_STUCK_RUN_SCAN_LIMIT
  }
): StuckRunRecoveryScopePolicy[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const policies: StuckRunRecoveryScopePolicy[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    policies.push({
      tenantId: asScopeToken(record.tenantId),
      workspaceId: asScopeToken(record.workspaceId),
      staleAfterSeconds: asScopePositiveInt(record.staleAfterSeconds, defaults.staleAfterSeconds, 0),
      limit: asScopePositiveInt(record.limit, defaults.limit, 1),
      enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SCOPE_POLICY_ENABLED
    });
  }

  return policies;
}

function formatRecoveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function candidateAgeSeconds(candidate: StuckRunCandidate, nowMs: number): number {
  const updatedMs = Date.parse(candidate.updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Math.floor((nowMs - updatedMs) / 1000));
}

function policyMatchScore(candidate: StuckRunCandidate, policy: StuckRunRecoveryScopePolicy): number {
  const tenantMatches = policy.tenantId === "*" || policy.tenantId === candidate.tenantId;
  if (!tenantMatches) {
    return -1;
  }

  const workspaceMatches = policy.workspaceId === "*" || policy.workspaceId === candidate.workspaceId;
  if (!workspaceMatches) {
    return -1;
  }

  const tenantSpecificity = policy.tenantId === candidate.tenantId ? 2 : 0;
  const workspaceSpecificity = policy.workspaceId === candidate.workspaceId ? 1 : 0;
  return tenantSpecificity + workspaceSpecificity;
}

function resolveCandidatePolicy(
  candidate: StuckRunCandidate,
  defaults: {
    staleAfterSeconds: number;
    limit: number;
  },
  policies: StuckRunRecoveryScopePolicy[]
): StuckRunRecoveryScopePolicy {
  let winner: StuckRunRecoveryScopePolicy | null = null;
  let winnerScore = -1;

  for (const policy of policies) {
    const score = policyMatchScore(candidate, policy);
    if (score > winnerScore) {
      winner = policy;
      winnerScore = score;
    }
  }

  if (winner) {
    return winner;
  }

  return {
    tenantId: candidate.tenantId,
    workspaceId: candidate.workspaceId,
    staleAfterSeconds: defaults.staleAfterSeconds,
    limit: defaults.limit,
    enabled: DEFAULT_SCOPE_POLICY_ENABLED
  };
}

export async function runStuckRunRecoveryScan(
  store: RunStore = persistence,
  input: { staleAfterSeconds?: number; limit?: number; policies?: StuckRunRecoveryScopePolicy[] } = {}
): Promise<StuckRunRecoveryReport> {
  const staleAfterSeconds = input.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  const limit = input.limit ?? DEFAULT_STUCK_RUN_SCAN_LIMIT;
  const policies = input.policies ?? [];
  const effectiveStaleAfterSeconds = policies.reduce(
    (minimum, policy) => Math.min(minimum, policy.staleAfterSeconds),
    staleAfterSeconds
  );
  const effectiveScanLimit = policies.reduce((maximum, policy) => Math.max(maximum, policy.limit), limit);
  const generatedAt = new Date().toISOString();
  const candidates = await store.listStuckRuns({
    staleAfterSeconds: effectiveStaleAfterSeconds,
    limit: effectiveScanLimit
  });

  const runs: StuckRunRecoveryRecord[] = [];
  const detectedAtMs = Date.parse(generatedAt);
  const scopeCounts = new Map<string, number>();
  let recovered = 0;
  let deadLettered = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const policy = resolveCandidatePolicy(
      candidate,
      {
        staleAfterSeconds,
        limit
      },
      policies
    );
    const scopeKey = `${candidate.tenantId}:${candidate.workspaceId}`;
    const recoveredInScope = scopeCounts.get(scopeKey) ?? 0;
    const ageSeconds = candidateAgeSeconds(candidate, detectedAtMs);

    if (!policy.enabled) {
      skipped += 1;
      runs.push({
        runId: candidate.runId,
        tenantId: candidate.tenantId,
        workspaceId: candidate.workspaceId,
        workflowId: candidate.workflowId,
        status: "skipped",
        reason: "Scope policy disabled automatic stuck-run recovery.",
        detectedAt: generatedAt
      });
      continue;
    }

    if (ageSeconds < policy.staleAfterSeconds) {
      skipped += 1;
      runs.push({
        runId: candidate.runId,
        tenantId: candidate.tenantId,
        workspaceId: candidate.workspaceId,
        workflowId: candidate.workflowId,
        status: "skipped",
        reason: `Candidate age (${ageSeconds}s) is below scope stale threshold (${policy.staleAfterSeconds}s).`,
        detectedAt: generatedAt
      });
      continue;
    }

    if (recoveredInScope >= policy.limit) {
      skipped += 1;
      runs.push({
        runId: candidate.runId,
        tenantId: candidate.tenantId,
        workspaceId: candidate.workspaceId,
        workflowId: candidate.workflowId,
        status: "skipped",
        reason: `Scope recovery limit reached (${policy.limit}).`,
        detectedAt: generatedAt
      });
      continue;
    }

    scopeCounts.set(scopeKey, recoveredInScope + 1);
    const reason = automaticRecoveryReason(candidate, policy.staleAfterSeconds, generatedAt);
    let escalation: Awaited<ReturnType<RunStore["escalateRun"]>> = null;
    let escalationError: string | null = null;
    try {
      escalation = await store.escalateRun(
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
    } catch (error) {
      escalationError = formatRecoveryError(error);
    }

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

    const deadLetterReason = automaticDeadLetterReason(candidate, policy.staleAfterSeconds, generatedAt);
    const deadLetterDetails = {
      deadLetterReason,
      detectedAt: generatedAt,
      actorId: STUCK_RUN_RECOVERY_ACTOR,
      replayReference: {
        sourceRunId: candidate.runId,
        workflowId: candidate.workflowId,
        recommendedAction: DEAD_LETTER_ACTION
      },
      ...(escalationError ? { escalationError } : {})
    };

    try {
      await store.updateStatus(candidate.runId, "failed", deadLetterDetails, `dead_letter:${candidate.runId}:${generatedAt}`);
      await store.storeArtifact(
        candidate.runId,
        "stuck-run-dead-letter",
        JSON.stringify({
          detectorId: STUCK_RUN_DETECTOR_ID,
          staleAfterSeconds: policy.staleAfterSeconds,
          deadLetteredAt: generatedAt,
          actorId: STUCK_RUN_RECOVERY_ACTOR,
          replayReference: deadLetterDetails.replayReference,
          reason: deadLetterReason,
          ...(escalationError ? { escalationError } : {})
        })
      );

      deadLettered += 1;
      runs.push({
        runId: candidate.runId,
        tenantId: candidate.tenantId,
        workspaceId: candidate.workspaceId,
        workflowId: candidate.workflowId,
        status: "dead_letter",
        reason: deadLetterReason,
        detectedAt: generatedAt
      });
    } catch (error) {
      skipped += 1;
      runs.push({
        runId: candidate.runId,
        tenantId: candidate.tenantId,
        workspaceId: candidate.workspaceId,
        workflowId: candidate.workflowId,
        status: "skipped",
        reason: `Dead-letter fallback failed: ${formatRecoveryError(error)}`,
        detectedAt: generatedAt
      });
    }
  }

  return {
    generatedAt,
    detectorId: STUCK_RUN_DETECTOR_ID,
    staleAfterSeconds,
    scanned: candidates.length,
    recovered,
    deadLettered,
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
    const staleAfterSeconds = parsePositiveInt(
      process.env.HARBOR_STUCK_RUN_STALE_AFTER_SECONDS,
      DEFAULT_STALE_AFTER_SECONDS,
      0
    );
    const limit = parsePositiveInt(process.env.HARBOR_STUCK_RUN_SCAN_LIMIT, DEFAULT_STUCK_RUN_SCAN_LIMIT, 1);
    const policies = resolveStuckRunRecoveryPolicies(process.env.HARBOR_STUCK_RUN_POLICIES, {
      staleAfterSeconds,
      limit
    });

    return runStuckRunRecoveryScan(persistence, { staleAfterSeconds, limit, policies });
  }
);

export const functions = [workflowRunRequested, adversarialNightlyScheduled, stuckRunRecoveryScheduled];
