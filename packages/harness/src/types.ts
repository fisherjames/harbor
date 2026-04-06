export interface MemoryPolicy {
  retrievalMode: "monitor" | "reason";
  maxContextItems: number;
  writebackEnabled: boolean;
  piiRetention: "forbidden" | "redacted" | "allowed";
}

export type EvaluatorVerdict = "pass" | "fail";

export interface EvaluatorRubric {
  rubricVersion: string;
  benchmarkSetId: string;
  calibratedAt: string;
  minimumAgreement: number;
  maximumDrift: number;
}

export interface EvaluatorBenchmarkObservation {
  scenarioId: string;
  expectedVerdict: EvaluatorVerdict;
  observedVerdict: EvaluatorVerdict;
}

export interface EvaluatorCalibrationReport {
  rubricVersion: string;
  benchmarkSetId: string;
  calibratedAt: string;
  agreementScore: number;
  driftScore: number;
  minimumAgreement: number;
  maximumDrift: number;
  driftDetected: boolean;
  failingScenarioIds: string[];
}

export type LintSeverity = "info" | "warning" | "critical";

export interface PromptPatch {
  section: "constraints" | "verification" | "tooling" | "memory";
  operation: "append" | "replace";
  content: string;
}

export interface LintFinding {
  findingId: string;
  ruleId: string;
  severity: LintSeverity;
  message: string;
  nodeId?: string | undefined;
  promptPatch?: PromptPatch | undefined;
  resolutionSteps: string[];
}

export type PromptStage = "plan" | "execute" | "verify" | "fix";
export type PolicySignatureAlgorithm = "sha256";

export interface HarnessPolicyDocument {
  version: string;
  issuedAt: string;
  constraints: {
    requireNodeOwner: boolean;
    requireNodeBudget: boolean;
    requireToolPolicy: boolean;
    requireMemoryPolicy: boolean;
    allowPromptMutationsOnlyInHarness: boolean;
  };
  runtime: {
    blockOnCriticalLint: boolean;
    maxFixAttempts: number;
    requireReplayBundle: boolean;
  };
}

export interface HarnessPolicyBundle {
  policyVersion: string;
  algorithm: PolicySignatureAlgorithm;
  checksum: string;
  signature: string;
  document: HarnessPolicyDocument;
}

export type WorkflowNodeType = "planner" | "executor" | "verifier" | "memory_write" | "tool_call";
export type HarnessRolloutMode = "active" | "canary" | "shadow";

export interface ToolCallPolicy {
  timeoutMs: number;
  retryLimit: number;
  maxCalls: number;
  sideEffectMode?: "read" | "propose" | "commit" | undefined;
  phaseGroup?: string | undefined;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label?: string | undefined;
  owner?: string | undefined;
  timeoutMs?: number | undefined;
  retryLimit?: number | undefined;
  promptTemplate?: string | undefined;
  toolPermissionScope?: string[] | undefined;
  toolCallPolicy?: ToolCallPolicy | undefined;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  objective: string;
  systemPrompt: string;
  rolloutMode?: HarnessRolloutMode | undefined;
  nodes: WorkflowNode[];
  memoryPolicy?: MemoryPolicy | undefined;
  policyBundle?: HarnessPolicyBundle | undefined;
}

export interface LintReport {
  findings: LintFinding[];
  blocked: boolean;
}

export interface RemediationRecommendation {
  ruleId: string;
  count: number;
  latestVersion: number;
  suggestion: string;
  templateTarget: "verification" | "tooling" | "budgeting" | "memory" | "general";
  promotionCandidate: boolean;
}

export interface AssemblePromptInput {
  stage: PromptStage;
  workflow: WorkflowDefinition;
  baseTask: string;
  platformSystemPrompt?: string | undefined;
  workflowSystemPrompt?: string | undefined;
  stageDirective?: string | undefined;
  memoryContext?: string | undefined;
  lintFindings?: LintFinding[] | undefined;
  resolutionSectionAppendix?: string | undefined;
}
