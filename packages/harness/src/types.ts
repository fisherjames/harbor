export interface MemoryPolicy {
  retrievalMode: "monitor" | "reason";
  maxContextItems: number;
  writebackEnabled: boolean;
  piiRetention: "forbidden" | "redacted" | "allowed";
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

export type WorkflowNodeType = "planner" | "executor" | "verifier" | "memory_write" | "tool_call";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label?: string | undefined;
  owner?: string | undefined;
  timeoutMs?: number | undefined;
  retryLimit?: number | undefined;
  promptTemplate?: string | undefined;
  toolPermissionScope?: string[] | undefined;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  objective: string;
  systemPrompt: string;
  nodes: WorkflowNode[];
  memoryPolicy?: MemoryPolicy | undefined;
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
  stage: "plan" | "execute" | "verify" | "fix";
  workflow: WorkflowDefinition;
  baseTask: string;
  memoryContext?: string | undefined;
  lintFindings?: LintFinding[] | undefined;
}
