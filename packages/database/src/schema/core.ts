import { integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const workspaces = pgTable("workspaces", {
  id: varchar("id", { length: 64 }).primaryKey(),
  tenantId: varchar("tenant_id", { length: 64 }).notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const workflows = pgTable("workflows", {
  id: varchar("id", { length: 64 }).primaryKey(),
  tenantId: varchar("tenant_id", { length: 64 }).notNull(),
  workspaceId: varchar("workspace_id", { length: 64 }).notNull(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  definition: jsonb("definition").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const executions = pgTable("executions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  workflowId: varchar("workflow_id", { length: 64 }).notNull(),
  tenantId: varchar("tenant_id", { length: 64 }).notNull(),
  workspaceId: varchar("workspace_id", { length: 64 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  trigger: varchar("trigger", { length: 32 }).notNull(),
  actorId: varchar("actor_id", { length: 64 }).notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const executionStages = pgTable("execution_stages", {
  id: varchar("id", { length: 64 }).primaryKey(),
  executionId: varchar("execution_id", { length: 64 }).notNull(),
  stage: varchar("stage", { length: 32 }).notNull(),
  prompt: text("prompt").notNull(),
  output: text("output").notNull(),
  attempts: integer("attempts").notNull(),
  tokenUsage: jsonb("token_usage"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull()
});

export const artifacts = pgTable("artifacts", {
  id: varchar("id", { length: 64 }).primaryKey(),
  executionId: varchar("execution_id", { length: 64 }).notNull(),
  name: varchar("name", { length: 128 }).notNull(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const auditLogs = pgTable("audit_logs", {
  id: varchar("id", { length: 64 }).primaryKey(),
  tenantId: varchar("tenant_id", { length: 64 }).notNull(),
  workspaceId: varchar("workspace_id", { length: 64 }).notNull(),
  actorId: varchar("actor_id", { length: 64 }).notNull(),
  action: varchar("action", { length: 128 }).notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});
