import type { WorkflowDefinition } from "@harbor/harness";

export type WorkflowVersionState = "draft" | "published";

export interface WorkflowVersionRecord {
  tenantId: string;
  workspaceId: string;
  workflowId: string;
  version: number;
  state: WorkflowVersionState;
  savedAt: string;
  savedBy: string;
  workflow: WorkflowDefinition;
}

export interface WorkflowRegistryScope {
  tenantId: string;
  workspaceId: string;
}

export interface SaveWorkflowVersionInput {
  workflow: WorkflowDefinition;
  actorId: string;
  state?: WorkflowVersionState | undefined;
}

export interface PublishWorkflowVersionInput {
  workflowId: string;
  version: number;
  actorId: string;
}

export interface WorkflowRegistry {
  saveVersion(scope: WorkflowRegistryScope, input: SaveWorkflowVersionInput): Promise<WorkflowVersionRecord>;
  publishVersion(
    scope: WorkflowRegistryScope,
    input: PublishWorkflowVersionInput
  ): Promise<WorkflowVersionRecord | null>;
  listVersions(scope: WorkflowRegistryScope, workflowId: string): Promise<WorkflowVersionRecord[]>;
  getVersion(
    scope: WorkflowRegistryScope,
    workflowId: string,
    version: number
  ): Promise<WorkflowVersionRecord | null>;
}
