import { describe, expect, it } from "vitest";
import {
  filterFindingsForPrompt,
  generateRemediationRecommendations,
  HAR_RULE_IDS,
  HAR_TEMPLATE_TARGET_BY_RULE,
  lintWorkflowDefinition,
  runLintAtExecutionPoint,
  summarizePostRunFindings,
  type WorkflowDefinition
} from "../src/index.js";

const baseWorkflow: WorkflowDefinition = {
  id: "wf_1",
  name: "Example",
  version: 1,
  objective: "Produce a verified answer",
  systemPrompt:
    "You must follow explicit constraints, never exceed allowed tool scope, and return PASS or FAIL verification. For plan, verify, and fix stages include confidence (0-1) and optional rationale.",
  memoryPolicy: {
    retrievalMode: "monitor",
    maxContextItems: 8,
    writebackEnabled: true,
    piiRetention: "redacted"
  },
  nodes: [
    {
      id: "plan",
      type: "planner",
      timeoutMs: 2_000,
      retryLimit: 1,
      owner: "system"
    },
    {
      id: "exec",
      type: "executor",
      timeoutMs: 2_000,
      retryLimit: 1,
      owner: "system"
    },
    {
      id: "verify",
      type: "verifier",
      timeoutMs: 2_000,
      retryLimit: 1,
      owner: "system"
    }
  ]
};

describe("lintWorkflowDefinition", () => {
  it("passes a valid workflow", () => {
    const report = lintWorkflowDefinition(baseWorkflow);

    expect(report.blocked).toBe(false);
    expect(report.findings).toHaveLength(0);
  });

  it("blocks when workflow system prompt is blank after trimming", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      systemPrompt: "   "
    });

    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "HAR006" && f.severity === "critical")).toBe(true);
  });

  it("adds warning when system prompt lacks explicit constraint language", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      systemPrompt: "Follow the workflow objective and answer clearly with PASS/FAIL."
    });

    expect(report.blocked).toBe(false);
    expect(report.findings.some((f) => f.ruleId === "HAR007" && f.severity === "warning")).toBe(true);
  });

  it("adds warning when system prompt lacks verification language", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      systemPrompt: "You must follow constraints and only use approved tools."
    });

    expect(report.blocked).toBe(false);
    expect(report.findings.some((f) => f.ruleId === "HAR008" && f.severity === "warning")).toBe(true);
  });

  it("blocks when verifier node is missing", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.filter((node) => node.type !== "verifier")
    });

    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "HAR001" && f.severity === "critical")).toBe(true);
  });

  it("detects unbounded tool permissions", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: "tool",
          type: "tool_call",
          timeoutMs: 1_000,
          retryLimit: 1,
          owner: "system",
          toolPermissionScope: ["*"]
        }
      ]
    });

    expect(report.findings.some((f) => f.ruleId === "HAR002")).toBe(true);
    expect(report.blocked).toBe(true);
  });

  it("adds warning when tool call policy is missing", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: "tool",
          type: "tool_call",
          timeoutMs: 1_000,
          retryLimit: 1,
          owner: "system",
          toolPermissionScope: ["search"]
        }
      ]
    });

    expect(report.findings.some((f) => f.ruleId === "HAR005" && f.severity === "warning")).toBe(true);
    expect(report.blocked).toBe(false);
  });

  it("accepts valid tool call policy", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: "tool",
          type: "tool_call",
          timeoutMs: 1_000,
          retryLimit: 1,
          owner: "system",
          toolPermissionScope: ["search"],
          toolCallPolicy: {
            timeoutMs: 800,
            retryLimit: 2,
            maxCalls: 3
          }
        }
      ]
    });

    expect(report.findings.some((f) => f.ruleId === "HAR005")).toBe(false);
  });

  it("blocks when commit side-effect tool has no matching propose phase", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: "tool-commit",
          type: "tool_call",
          timeoutMs: 1_000,
          retryLimit: 1,
          owner: "system",
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 800,
            retryLimit: 2,
            maxCalls: 1,
            sideEffectMode: "commit",
            phaseGroup: "payments"
          }
        }
      ]
    });

    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "HAR010" && f.severity === "critical")).toBe(true);
  });

  it("blocks when mutating tool mode is missing phaseGroup", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: "tool-propose",
          type: "tool_call",
          timeoutMs: 1_000,
          retryLimit: 1,
          owner: "system",
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 800,
            retryLimit: 2,
            maxCalls: 1,
            sideEffectMode: "propose"
          }
        }
      ]
    });

    expect(report.blocked).toBe(true);
    expect(
      report.findings.some((finding) => finding.ruleId === "HAR010" && finding.message.includes("without phaseGroup"))
    ).toBe(true);
  });

  it("accepts matching propose/commit side-effect tool phases", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: "tool-propose",
          type: "tool_call",
          timeoutMs: 1_000,
          retryLimit: 1,
          owner: "system",
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 800,
            retryLimit: 2,
            maxCalls: 1,
            sideEffectMode: "propose",
            phaseGroup: "payments"
          }
        },
        {
          id: "tool-commit",
          type: "tool_call",
          timeoutMs: 1_000,
          retryLimit: 1,
          owner: "system",
          toolPermissionScope: ["payments:write"],
          toolCallPolicy: {
            timeoutMs: 800,
            retryLimit: 2,
            maxCalls: 1,
            sideEffectMode: "commit",
            phaseGroup: "payments"
          }
        }
      ]
    });

    expect(report.findings.some((f) => f.ruleId === "HAR010")).toBe(false);
  });

  it("adds warning when node budgets are missing", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: [
        {
          id: "plan",
          type: "planner"
        },
        ...baseWorkflow.nodes.slice(1)
      ]
    });

    expect(report.findings.some((f) => f.ruleId === "HAR003" && f.severity === "warning")).toBe(true);
  });

  it("blocks invalid memory policy", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      memoryPolicy: {
        retrievalMode: "monitor",
        maxContextItems: 0,
        writebackEnabled: true,
        piiRetention: "redacted"
      }
    });

    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "HAR004")).toBe(true);
  });

  it("blocks when memory policy is missing", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      memoryPolicy: undefined
    });

    expect(report.findings.some((f) => f.ruleId === "HAR004" && f.message.includes("missing"))).toBe(true);
  });

  it("summarizes recurring post-run findings", () => {
    const lint = runLintAtExecutionPoint("post-run", {
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.filter((node) => node.type !== "verifier")
    });

    const summary = summarizePostRunFindings([{ workflowVersion: 3, findings: lint.report.findings }]);
    expect(summary.HAR001.count).toBe(1);
    expect(summary.HAR001.latestVersion).toBe(3);
  });

  it("increments recurring findings and keeps latest workflow version", () => {
    const lint = runLintAtExecutionPoint("post-run", {
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.filter((node) => node.type !== "verifier")
    });

    const summary = summarizePostRunFindings([
      { workflowVersion: 1, findings: lint.report.findings },
      { workflowVersion: 4, findings: lint.report.findings }
    ]);

    expect(summary.HAR001.count).toBe(2);
    expect(summary.HAR001.latestVersion).toBe(4);
  });

  it("filters critical findings from prompt injection list", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.filter((node) => node.type !== "verifier")
    });

    const filtered = filterFindingsForPrompt(report.findings);
    expect(filtered.some((f) => f.severity === "critical")).toBe(false);
  });

  it("generates deterministic remediation recommendations", () => {
    const summary = summarizePostRunFindings([
      {
        workflowVersion: 2,
        findings: [
          {
            findingId: "HAR003:a",
            ruleId: "HAR003",
            severity: "warning",
            message: "Missing timeout",
            resolutionSteps: ["Add timeout"]
          }
        ]
      },
      {
        workflowVersion: 4,
        findings: [
          {
            findingId: "HAR003:b",
            ruleId: "HAR003",
            severity: "warning",
            message: "Missing retry",
            resolutionSteps: ["Add retry"]
          },
          {
            findingId: "HAR999:a",
            ruleId: "HAR999",
            severity: "info",
            message: "Unknown style issue",
            resolutionSteps: ["Apply style fix"]
          }
        ]
      }
    ]);

    const recommendations = generateRemediationRecommendations(summary, 2);
    expect(recommendations[0].ruleId).toBe("HAR003");
    expect(recommendations[0].promotionCandidate).toBe(true);
    expect(recommendations[1].ruleId).toBe("HAR999");
    expect(recommendations[1].templateTarget).toBe("general");
  });

  it("maps all core rule recommendations to expected template targets", () => {
    const recommendations = generateRemediationRecommendations({
      HAR001: { count: 1, latestVersion: 1 },
      HAR002: { count: 1, latestVersion: 1 },
      HAR003: { count: 1, latestVersion: 1 },
      HAR005: { count: 1, latestVersion: 1 },
      HAR004: { count: 1, latestVersion: 1 }
    });

    for (const ruleId of HAR_RULE_IDS) {
      expect(recommendations.find((item) => item.ruleId === ruleId)?.templateTarget).toBe(
        HAR_TEMPLATE_TARGET_BY_RULE[ruleId]
      );
    }
  });

  it("maps extended system-prompt rules to targeted remediation recommendations", () => {
    const recommendations = generateRemediationRecommendations({
      HAR007: { count: 2, latestVersion: 5 },
      HAR008: { count: 1, latestVersion: 5 },
      HAR009: { count: 1, latestVersion: 5 },
      HAR010: { count: 1, latestVersion: 5 }
    });

    expect(recommendations.find((item) => item.ruleId === "HAR007")?.templateTarget).toBe("verification");
    expect(recommendations.find((item) => item.ruleId === "HAR007")?.suggestion).toContain("MUST/NEVER");
    expect(recommendations.find((item) => item.ruleId === "HAR008")?.templateTarget).toBe("verification");
    expect(recommendations.find((item) => item.ruleId === "HAR008")?.suggestion).toContain("PASS/FAIL");
    expect(recommendations.find((item) => item.ruleId === "HAR009")?.templateTarget).toBe("verification");
    expect(recommendations.find((item) => item.ruleId === "HAR009")?.suggestion).toContain("confidence");
    expect(recommendations.find((item) => item.ruleId === "HAR010")?.templateTarget).toBe("tooling");
    expect(recommendations.find((item) => item.ruleId === "HAR010")?.suggestion).toContain("two-phase");
  });

  it("adds warning when system prompt lacks confidence output contract", () => {
    const report = lintWorkflowDefinition({
      ...baseWorkflow,
      systemPrompt: "You must follow constraints and return PASS or FAIL verification."
    });

    expect(report.blocked).toBe(false);
    expect(report.findings.some((f) => f.ruleId === "HAR009" && f.severity === "warning")).toBe(true);
  });
});
