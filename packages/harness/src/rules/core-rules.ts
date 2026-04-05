import { z } from "zod";
import type { LintFinding, WorkflowDefinition } from "../types.js";

function buildFindingId(ruleId: string, suffix: string): string {
  return `${ruleId}:${suffix}`;
}

export function applyCoreHarnessRules(workflow: WorkflowDefinition): LintFinding[] {
  const findings: LintFinding[] = [];
  const memoryPolicySchema = z.object({
    retrievalMode: z.enum(["monitor", "reason"]),
    maxContextItems: z.number().int().min(1).max(200),
    writebackEnabled: z.boolean(),
    piiRetention: z.enum(["forbidden", "redacted", "allowed"])
  });
  const toolCallPolicySchema = z.object({
    timeoutMs: z.number().int().positive(),
    retryLimit: z.number().int().min(0),
    maxCalls: z.number().int().min(1).max(1_000)
  });

  const hasVerifier = workflow.nodes.some((node) => node.type === "verifier");
  if (!hasVerifier) {
    findings.push({
      findingId: buildFindingId("HAR001", workflow.id),
      ruleId: "HAR001",
      severity: "critical",
      message: "Workflow is missing a verifier node.",
      promptPatch: {
        section: "verification",
        operation: "append",
        content: "Add a verifier stage with explicit PASS/FAIL criteria and acceptance checks."
      },
      resolutionSteps: [
        "Create a verifier node in the workflow graph.",
        "Define explicit PASS/FAIL output contract.",
        "Require verifier stage before marking run complete."
      ]
    });
  }

  for (const node of workflow.nodes) {
    if (node.type !== "tool_call") {
      continue;
    }

    if (!node.toolPermissionScope || node.toolPermissionScope.length === 0 || node.toolPermissionScope.includes("*")) {
      findings.push({
        findingId: buildFindingId("HAR002", node.id),
        ruleId: "HAR002",
        severity: "critical",
        message: "Tool node has unbounded or missing permission scope.",
        nodeId: node.id,
        promptPatch: {
          section: "tooling",
          operation: "append",
          content:
            "Restrict tool calls to explicit allow-list scopes and fail closed on unauthorized requests."
        },
        resolutionSteps: [
          `Set explicit toolPermissionScope on node ${node.id}.`,
          "Deny all tools not explicitly listed in scope.",
          "Record denied tool attempts in trace logs."
        ]
      });
    }

    const toolPolicyValidation = toolCallPolicySchema.safeParse(node.toolCallPolicy);
    if (!toolPolicyValidation.success) {
      findings.push({
        findingId: buildFindingId("HAR005", node.id),
        ruleId: "HAR005",
        severity: "warning",
        message: `Tool node is missing or has invalid toolCallPolicy: ${toolPolicyValidation.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
        nodeId: node.id,
        promptPatch: {
          section: "tooling",
          operation: "append",
          content: `Declare timeoutMs, retryLimit, and maxCalls in toolCallPolicy for node ${node.id}.`
        },
        resolutionSteps: [
          `Set toolCallPolicy.timeoutMs, retryLimit, and maxCalls on node ${node.id}.`,
          "Cap tool invocations using maxCalls to prevent runaway loops.",
          "Escalate to human after retry budget exhaustion for tool failures."
        ]
      });
    }
  }

  for (const node of workflow.nodes) {
    if (typeof node.timeoutMs === "number" && typeof node.retryLimit === "number") {
      continue;
    }

    findings.push({
      findingId: buildFindingId("HAR003", node.id),
      ruleId: "HAR003",
      severity: "warning",
      message: "Node is missing timeout and/or retry budget.",
      nodeId: node.id,
      promptPatch: {
        section: "constraints",
        operation: "append",
        content: `Enforce timeoutMs and retryLimit for node ${node.id}.`
      },
      resolutionSteps: [
        `Add timeoutMs and retryLimit to node ${node.id}.`,
        "Escalate to human after retry budget exhaustion."
      ]
    });
  }

  if (!workflow.memoryPolicy) {
    findings.push({
      findingId: buildFindingId("HAR004", workflow.id),
      ruleId: "HAR004",
      severity: "critical",
      message: "Workflow is missing memU retrieval policy.",
      promptPatch: {
        section: "memory",
        operation: "append",
        content:
          "Define memory retrieval mode, context item limit, writeback policy, and PII retention handling."
      },
      resolutionSteps: [
        "Set memoryPolicy.retrievalMode to monitor or reason.",
        "Set memoryPolicy.maxContextItems to a bounded integer.",
        "Set memoryPolicy.writebackEnabled and piiRetention explicitly."
      ]
    });
  } else {
    const validation = memoryPolicySchema.safeParse(workflow.memoryPolicy);
    if (!validation.success) {
      findings.push({
        findingId: buildFindingId("HAR004", workflow.id),
        ruleId: "HAR004",
        severity: "critical",
        message: `Workflow memU policy is invalid: ${validation.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
        promptPatch: {
          section: "memory",
          operation: "append",
          content: "Fix invalid memory policy values before deployment."
        },
        resolutionSteps: [
          ...validation.error.issues.map(
            (error: { path: (string | number)[]; message: string }) =>
              `Fix memory policy issue: ${error.path.join(".")}: ${error.message}`
          )
        ]
      });
    }
  }

  return findings;
}
