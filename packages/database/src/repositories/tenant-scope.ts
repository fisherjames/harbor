export interface TenantScope {
  tenantId: string;
  workspaceId: string;
}

export function assertTenantScope(scope: TenantScope): void {
  if (!scope.tenantId.trim()) {
    throw new Error("tenantId is required for scoped repository operations");
  }

  if (!scope.workspaceId.trim()) {
    throw new Error("workspaceId is required for scoped repository operations");
  }
}
