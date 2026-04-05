import { applyCoreHarnessRules } from "./rules/core-rules.js";
import type { LintFinding, LintReport, WorkflowDefinition } from "./types.js";

export function lintWorkflowDefinition(workflow: WorkflowDefinition): LintReport {
  const findings = applyCoreHarnessRules(workflow);
  const blocked = findings.some((finding) => finding.severity === "critical");

  return {
    findings,
    blocked
  };
}

export function filterFindingsForPrompt(findings: LintFinding[]): LintFinding[] {
  return findings.filter((finding) => finding.severity !== "critical");
}

export type LintExecutionPoint = "save" | "deploy" | "runtime-pre-stage" | "post-run";

export interface LintExecutionResult {
  point: LintExecutionPoint;
  report: LintReport;
}

export function runLintAtExecutionPoint(
  point: LintExecutionPoint,
  workflow: WorkflowDefinition
): LintExecutionResult {
  return {
    point,
    report: lintWorkflowDefinition(workflow)
  };
}

export function summarizePostRunFindings(
  runFindings: Array<{ workflowVersion: number; findings: LintFinding[] }>
): Record<string, { count: number; latestVersion: number }> {
  const summary: Record<string, { count: number; latestVersion: number }> = {};

  for (const run of runFindings) {
    for (const finding of run.findings) {
      const existing = summary[finding.ruleId];
      if (!existing) {
        summary[finding.ruleId] = { count: 1, latestVersion: run.workflowVersion };
        continue;
      }

      existing.count += 1;
      existing.latestVersion = Math.max(existing.latestVersion, run.workflowVersion);
    }
  }

  return summary;
}
