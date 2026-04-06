import { applyCoreHarnessRules } from "./rules/core-rules.js";
import {
  HAR_REMEDIATION_SUGGESTION_BY_RULE,
  HAR_TEMPLATE_TARGET_BY_RULE,
  isHarRuleId
} from "./rules/har-catalog.js";
import type {
  LintFinding,
  LintReport,
  RemediationRecommendation,
  WorkflowDefinition
} from "./types.js";

const EXTENDED_REMEDIATION_BY_RULE: Record<
  string,
  Pick<RemediationRecommendation, "suggestion" | "templateTarget">
> = {
  HAR006: {
    suggestion: "Promote system prompt baseline template with explicit role, constraints, and verification posture.",
    templateTarget: "general"
  },
  HAR007: {
    suggestion: "Promote system prompt constraint template using MUST/NEVER language.",
    templateTarget: "verification"
  },
  HAR008: {
    suggestion: "Promote system prompt verifier template with explicit PASS/FAIL acceptance expectations.",
    templateTarget: "verification"
  },
  HAR009: {
    suggestion:
      "Promote system prompt stage-output contract template requiring confidence (0-1) for plan/verify/fix stages.",
    templateTarget: "verification"
  },
  HAR010: {
    suggestion: "Promote two-phase side-effect template enforcing propose -> preview -> commit for mutating tools.",
    templateTarget: "tooling"
  }
};

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

function recommendationForRule(ruleId: string): Pick<RemediationRecommendation, "suggestion" | "templateTarget"> {
  if (isHarRuleId(ruleId)) {
    return {
      suggestion: HAR_REMEDIATION_SUGGESTION_BY_RULE[ruleId],
      templateTarget: HAR_TEMPLATE_TARGET_BY_RULE[ruleId]
    };
  }

  const extendedRecommendation = EXTENDED_REMEDIATION_BY_RULE[ruleId];
  if (extendedRecommendation) {
    return extendedRecommendation;
  }

  return {
    suggestion: "Promote a reusable harness template for this recurring finding.",
    templateTarget: "general"
  };
}

export function generateRemediationRecommendations(
  summary: Record<string, { count: number; latestVersion: number }>,
  promotionThreshold = 3
): RemediationRecommendation[] {
  return Object.entries(summary)
    .sort((a, b) => {
      if (a[1].count === b[1].count) {
        return a[0].localeCompare(b[0]);
      }

      return b[1].count - a[1].count;
    })
    .map(([ruleId, stats]) => {
      const recommendation = recommendationForRule(ruleId);

      return {
        ruleId,
        count: stats.count,
        latestVersion: stats.latestVersion,
        suggestion: recommendation.suggestion,
        templateTarget: recommendation.templateTarget,
        promotionCandidate: stats.count >= promotionThreshold
      };
    });
}
