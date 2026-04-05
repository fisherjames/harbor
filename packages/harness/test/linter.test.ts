import { describe, expect, it } from "vitest";
import {
  filterFindingsForPrompt,
  generateRemediationRecommendations,
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
  systemPrompt: "You are Harbor",
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
      HAR004: { count: 1, latestVersion: 1 }
    });

    expect(recommendations.find((item) => item.ruleId === "HAR001")?.templateTarget).toBe("verification");
    expect(recommendations.find((item) => item.ruleId === "HAR002")?.templateTarget).toBe("tooling");
    expect(recommendations.find((item) => item.ruleId === "HAR004")?.templateTarget).toBe("memory");
  });
});
