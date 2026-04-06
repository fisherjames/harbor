import type { HarnessRolloutMode, LintFinding, WorkflowDefinition } from "@harbor/harness";
import type { RunStatus, StageExecutionRecord } from "@harbor/engine";

export type DeployGateStatus = "passed" | "failed" | "skipped";
export type DeployBlockReason = "lint" | "eval" | "promotion" | "adversarial" | "shadow";

export interface EvaluatorCalibrationSummary {
  rubricVersion: string;
  benchmarkSetId: string;
  calibratedAt: string;
  agreementScore: number;
  driftScore: number;
  minimumAgreement: number;
  maximumDrift: number;
  driftDetected: boolean;
}

export interface EvalGateSummary {
  suiteId: string;
  status: DeployGateStatus;
  blocked: boolean;
  score: number;
  summary: string;
  failingScenarios: string[];
  calibration: EvaluatorCalibrationSummary;
}

export interface PromotionCheckSummary {
  checkId: string;
  status: DeployGateStatus;
  summary: string;
}

export interface PromotionGateSummary {
  provider: "github";
  repository: string;
  branch: string;
  status: DeployGateStatus;
  blocked: boolean;
  checks: PromotionCheckSummary[];
  pullRequestNumber?: number | undefined;
  pullRequestUrl?: string | undefined;
}

export type AdversarialFindingSeverity = "warning" | "critical";

export interface AdversarialFindingSummary {
  findingId: string;
  scenarioId: string;
  category: "prompt_injection" | "tool_permission_escalation" | "cross_tenant_access" | "memory_poisoning";
  severity: AdversarialFindingSeverity;
  summary: string;
  resolutionSteps: string[];
}

export interface AdversarialTaxonomySummary {
  totalFindings: number;
  criticalFindings: number;
  warningFindings: number;
  byCategory: Record<"prompt_injection" | "tool_permission_escalation" | "cross_tenant_access" | "memory_poisoning", number>;
  byScenario: Record<string, number>;
}

export interface AdversarialGateSummary {
  suiteId: string;
  status: DeployGateStatus;
  blocked: boolean;
  summary: string;
  findings: AdversarialFindingSummary[];
  taxonomy: AdversarialTaxonomySummary;
}

export interface ShadowGateComparisonSummary {
  baselineRunId: string;
  candidateRunId: string;
  parityScore: number;
  divergenceCount: number;
  artifactPath: string;
}

export interface ShadowGateSummary {
  mode: HarnessRolloutMode;
  status: DeployGateStatus;
  blocked: boolean;
  summary: string;
  comparison?: ShadowGateComparisonSummary | undefined;
}

export type BenchmarkBridgeStepId = "lint" | "eval" | "promotion" | "adversarial" | "shadow";
export type BenchmarkBridgeTarget = "deploy" | "publish" | "promotion";
export type BenchmarkBridgeNextAction =
  | "halt_and_remediate"
  | "deploy_workflow"
  | "publish_workflow"
  | "open_promotion_pull_request";

export interface BenchmarkBridgeStep {
  stepId: BenchmarkBridgeStepId;
  status: DeployGateStatus;
  blocked: boolean;
  summary: string;
}

export interface BenchmarkToProductionBridge {
  bridgeVersion: "v1";
  bridgeId: string;
  event: "deploy" | "publish";
  target: BenchmarkBridgeTarget;
  workflowId: string;
  version: number;
  rolloutMode: HarnessRolloutMode;
  blocked: boolean;
  blockedReasons: DeployBlockReason[];
  nextAction: BenchmarkBridgeNextAction;
  steps: BenchmarkBridgeStep[];
}

export interface DeployWorkflowInput {
  workflowId: string;
  expectedVersion: number;
  workflow: WorkflowDefinition;
}

export interface DeployWorkflowOutput {
  deploymentId: string;
  lintFindings: LintFinding[];
  evalGate: EvalGateSummary;
  promotionGate: PromotionGateSummary;
  adversarialGate: AdversarialGateSummary;
  shadowGate: ShadowGateSummary;
  bridge: BenchmarkToProductionBridge;
  blockedReasons: DeployBlockReason[];
  blocked: boolean;
  policyVersion?: string | undefined;
  policySignature?: string | undefined;
}

export interface HarborApiContext {
  tenantId: string;
  workspaceId: string;
  actorId: string;
}

export interface RunTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  status: RunStatus;
  trigger: "manual" | "schedule" | "api";
  actorId: string;
  createdAt: string;
  updatedAt: string;
  tokenUsage: RunTokenUsage;
}

export interface RunDetail extends RunSummary {
  input: Record<string, unknown>;
  output?: Record<string, unknown> | undefined;
  details?: Record<string, unknown> | undefined;
  lintFindings: LintFinding[];
  stages: StageExecutionRecord[];
  artifacts: Record<string, string>;
}

export interface ListRunsInput {
  limit?: number | undefined;
  status?: RunStatus | undefined;
  workflowId?: string | undefined;
}

export interface EscalateRunInput {
  runId: string;
  reason?: string | undefined;
}

export interface EscalateRunOutput {
  runId: string;
  status: "needs_human";
  updatedAt: string;
}

export type WorkflowVersionState = "draft" | "published";

export interface WorkflowVersionSummary {
  workflowId: string;
  version: number;
  state: WorkflowVersionState;
  savedAt: string;
  savedBy: string;
}

export interface SaveWorkflowVersionInput {
  workflow: WorkflowDefinition;
  state?: WorkflowVersionState | undefined;
}

export interface SaveWorkflowVersionOutput extends WorkflowVersionSummary {
  lintFindings: LintFinding[];
  blocked: boolean;
}

export interface ListWorkflowVersionsInput {
  workflowId: string;
}

export interface GetWorkflowVersionInput {
  workflowId: string;
  version: number;
}

export interface WorkflowVersionDetail extends WorkflowVersionSummary {
  workflow: WorkflowDefinition;
}

export interface PublishWorkflowVersionInput {
  workflowId: string;
  version: number;
}

export interface PublishWorkflowVersionOutput {
  workflowId: string;
  version: number;
  state: "published";
  lintFindings: LintFinding[];
  evalGate: EvalGateSummary;
  promotionGate: PromotionGateSummary;
  adversarialGate: AdversarialGateSummary;
  shadowGate: ShadowGateSummary;
  bridge: BenchmarkToProductionBridge;
  blockedReasons: DeployBlockReason[];
  blocked: boolean;
  policyVersion?: string | undefined;
  policySignature?: string | undefined;
}

export interface OpenPromotionPullRequestInput {
  workflowId: string;
  version: number;
  baseBranch?: string | undefined;
  headBranch?: string | undefined;
}

export interface PromotionPullRequestResult {
  repository: string;
  baseBranch: string;
  headBranch: string;
  artifactPath: string;
  status: "created" | "skipped";
  summary: string;
  pullRequestNumber?: number | undefined;
  pullRequestUrl?: string | undefined;
}

export interface OpenPromotionPullRequestOutput {
  workflowId: string;
  version: number;
  lintFindings: LintFinding[];
  evalGate: EvalGateSummary;
  promotionGate: PromotionGateSummary;
  adversarialGate: AdversarialGateSummary;
  shadowGate: ShadowGateSummary;
  bridge: BenchmarkToProductionBridge;
  blockedReasons: DeployBlockReason[];
  blocked: boolean;
  promotion: PromotionPullRequestResult;
  policyVersion?: string | undefined;
  policySignature?: string | undefined;
}
