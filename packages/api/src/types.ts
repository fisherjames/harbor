import type { LintFinding, WorkflowDefinition } from "@harbor/harness";

export interface DeployWorkflowInput {
  workflowId: string;
  expectedVersion: number;
  workflow: WorkflowDefinition;
}

export interface DeployWorkflowOutput {
  deploymentId: string;
  lintFindings: LintFinding[];
  blocked: boolean;
}

export interface HarborApiContext {
  tenantId: string;
  workspaceId: string;
  actorId: string;
}
