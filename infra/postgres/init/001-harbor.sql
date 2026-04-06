CREATE TABLE IF NOT EXISTS executions (
  id VARCHAR(128) PRIMARY KEY,
  workflow_id VARCHAR(128) NOT NULL,
  tenant_id VARCHAR(128) NOT NULL,
  workspace_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  trigger VARCHAR(32) NOT NULL,
  actor_id VARCHAR(128) NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_executions_tenant_workspace_created
  ON executions (tenant_id, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_status_updated
  ON executions (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_executions_workflow
  ON executions (workflow_id);

CREATE TABLE IF NOT EXISTS execution_stages (
  id VARCHAR(128) PRIMARY KEY,
  execution_id VARCHAR(128) NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  stage VARCHAR(32) NOT NULL,
  prompt TEXT NOT NULL,
  output TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  token_usage JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_stages_execution
  ON execution_stages (execution_id, started_at ASC);

CREATE TABLE IF NOT EXISTS artifacts (
  id VARCHAR(128) PRIMARY KEY,
  execution_id VARCHAR(128) NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_execution
  ON artifacts (execution_id, created_at ASC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(128) PRIMARY KEY,
  tenant_id VARCHAR(128) NOT NULL,
  workspace_id VARCHAR(128) NOT NULL,
  actor_id VARCHAR(128) NOT NULL,
  action VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_scope_created
  ON audit_logs (tenant_id, workspace_id, created_at DESC);
