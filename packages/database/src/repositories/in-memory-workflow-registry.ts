import type {
  PublishWorkflowVersionInput,
  SaveWorkflowVersionInput,
  WorkflowRegistry,
  WorkflowRegistryScope,
  WorkflowVersionRecord
} from "./workflow-registry.js";

interface RegistryState {
  versions: WorkflowVersionRecord[];
}

function stateKey(scope: WorkflowRegistryScope, workflowId: string): string {
  return `${scope.tenantId}:${scope.workspaceId}:${workflowId}`;
}

function cloneRecord(record: WorkflowVersionRecord): WorkflowVersionRecord {
  return structuredClone(record);
}

export class InMemoryWorkflowRegistry implements WorkflowRegistry {
  private readonly store = new Map<string, RegistryState>();

  async saveVersion(scope: WorkflowRegistryScope, input: SaveWorkflowVersionInput): Promise<WorkflowVersionRecord> {
    const key = stateKey(scope, input.workflow.id);
    const state = this.store.get(key) ?? { versions: [] };

    const existing = state.versions.find((record) => record.version === input.workflow.version);
    const now = new Date().toISOString();
    const nextState = input.state ?? "draft";

    if (existing) {
      existing.workflow = input.workflow;
      existing.state = nextState;
      existing.savedAt = now;
      existing.savedBy = input.actorId;
      this.store.set(key, state);
      return cloneRecord(existing);
    }

    const record: WorkflowVersionRecord = {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      workflowId: input.workflow.id,
      version: input.workflow.version,
      state: nextState,
      savedAt: now,
      savedBy: input.actorId,
      workflow: input.workflow
    };

    state.versions.push(record);
    state.versions.sort((a, b) => b.version - a.version);
    this.store.set(key, state);
    return cloneRecord(record);
  }

  async publishVersion(
    scope: WorkflowRegistryScope,
    input: PublishWorkflowVersionInput
  ): Promise<WorkflowVersionRecord | null> {
    const key = stateKey(scope, input.workflowId);
    const state = this.store.get(key);
    if (!state) {
      return null;
    }

    const target = state.versions.find((record) => record.version === input.version);
    if (!target) {
      return null;
    }

    const now = new Date().toISOString();
    for (const record of state.versions) {
      record.state = record.version === input.version ? "published" : "draft";
      if (record.version === input.version) {
        record.savedAt = now;
        record.savedBy = input.actorId;
      }
    }

    return cloneRecord(target);
  }

  async listVersions(scope: WorkflowRegistryScope, workflowId: string): Promise<WorkflowVersionRecord[]> {
    const key = stateKey(scope, workflowId);
    const state = this.store.get(key);
    if (!state) {
      return [];
    }

    return state.versions.map(cloneRecord);
  }

  async getVersion(
    scope: WorkflowRegistryScope,
    workflowId: string,
    version: number
  ): Promise<WorkflowVersionRecord | null> {
    const key = stateKey(scope, workflowId);
    const state = this.store.get(key);
    if (!state) {
      return null;
    }

    const record = state.versions.find((candidate) => candidate.version === version);
    return record ? cloneRecord(record) : null;
  }
}
