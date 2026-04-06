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
    maxCalls: z.number().int().min(1).max(1_000),
    sideEffectMode: z.enum(["read", "propose", "commit"]).optional(),
    phaseGroup: z.string().trim().min(1).max(120).optional()
  });
  const trimmedSystemPrompt = workflow.systemPrompt.trim();
  const toolNodes = workflow.nodes.filter((node) => node.type === "tool_call");

  if (trimmedSystemPrompt.length === 0) {
    findings.push({
      findingId: buildFindingId("HAR006", workflow.id),
      ruleId: "HAR006",
      severity: "critical",
      message: "Workflow system prompt is empty after trimming.",
      promptPatch: {
        section: "constraints",
        operation: "replace",
        content:
          "Define a non-empty workflow system prompt with explicit role, constraints, and verification posture."
      },
      resolutionSteps: [
        "Set workflow.systemPrompt to a non-empty instruction block.",
        "Include role, constraints, and verification intent in the workflow system prompt.",
        "Reject deploy/run requests when system prompt is blank."
      ]
    });

  }

  if (!/(must|never|do not|only)\b/i.test(trimmedSystemPrompt)) {
    findings.push({
      findingId: buildFindingId("HAR007", workflow.id),
      ruleId: "HAR007",
      severity: "warning",
      message: "Workflow system prompt is missing explicit constraint language.",
      promptPatch: {
        section: "constraints",
        operation: "append",
        content: "Add non-negotiable constraints using MUST/NEVER/DO NOT language."
      },
      resolutionSteps: [
        "Add explicit guardrail language (for example: MUST, NEVER, DO NOT, ONLY).",
        "Document tool and data boundaries directly in the workflow system prompt.",
        "Keep constraints concise and testable."
      ]
    });
  }

  if (!/(pass|fail|verify|acceptance)/i.test(trimmedSystemPrompt)) {
    findings.push({
      findingId: buildFindingId("HAR008", workflow.id),
      ruleId: "HAR008",
      severity: "warning",
      message: "Workflow system prompt is missing verification/acceptance language.",
      promptPatch: {
        section: "verification",
        operation: "append",
        content: "Require explicit verification expectations and PASS/FAIL acceptance checks."
      },
      resolutionSteps: [
        "Define verifier expectations directly in workflow.systemPrompt.",
        "Reference explicit PASS/FAIL acceptance checks.",
        "Ensure verifier output maps to deploy/run decisions."
      ]
    });
  }

  const hasConfidenceLanguage = /confidence/i.test(trimmedSystemPrompt);
  const hasConfidenceRange = /(0\s*(?:-|\.\.|to)\s*1|0\.0\s*-\s*1\.0)/i.test(trimmedSystemPrompt);
  const hasConfidenceStageContract = /(plan|verify|fix)/i.test(trimmedSystemPrompt);
  if (!hasConfidenceLanguage || !hasConfidenceRange || !hasConfidenceStageContract) {
    findings.push({
      findingId: buildFindingId("HAR009", workflow.id),
      ruleId: "HAR009",
      severity: "warning",
      message: "Workflow system prompt is missing explicit confidence output contract for plan/verify/fix stages.",
      promptPatch: {
        section: "verification",
        operation: "append",
        content:
          "For plan, verify, and fix stages include confidence (0-1) and optional confidence rationale in outputs."
      },
      resolutionSteps: [
        "Add confidence output contract to workflow.systemPrompt for plan, verify, and fix stages.",
        "Require confidence to be numeric and bounded to 0-1.",
        "Require optional confidence rationale when confidence is below threshold."
      ]
    });
  }

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

  for (const node of toolNodes) {
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

  const proposeGroups = new Set<string>();
  const commitGroups = new Set<string>();
  const commitNodeIdsByGroup = new Map<string, string[]>();

  for (const node of toolNodes) {
    const sideEffectMode = node.toolCallPolicy?.sideEffectMode ?? "read";
    if (sideEffectMode === "read") {
      continue;
    }

    const phaseGroup = node.toolCallPolicy?.phaseGroup?.trim();
    if (!phaseGroup) {
      findings.push({
        findingId: buildFindingId("HAR010", node.id),
        ruleId: "HAR010",
        severity: "critical",
        message: `Tool node ${node.id} uses sideEffectMode='${sideEffectMode}' without phaseGroup.`,
        nodeId: node.id,
        promptPatch: {
          section: "tooling",
          operation: "append",
          content:
            "For mutating tools, declare phaseGroup and enforce propose -> preview -> commit sequence before side effects."
        },
        resolutionSteps: [
          `Set toolCallPolicy.phaseGroup for node ${node.id}.`,
          "Use sideEffectMode=propose for preview-producing nodes.",
          "Use sideEffectMode=commit only after a matching propose phaseGroup is defined."
        ]
      });
      continue;
    }

    if (sideEffectMode === "propose") {
      proposeGroups.add(phaseGroup);
    }

    if (sideEffectMode === "commit") {
      commitGroups.add(phaseGroup);
      const existingNodeIds = commitNodeIdsByGroup.get(phaseGroup) ?? [];
      commitNodeIdsByGroup.set(phaseGroup, [...existingNodeIds, node.id]);
    }
  }

  for (const group of commitGroups) {
    if (proposeGroups.has(group)) {
      continue;
    }

    const commitNodeIds = commitNodeIdsByGroup.get(group) as string[];
    for (const nodeId of commitNodeIds) {
      findings.push({
        findingId: buildFindingId("HAR010", `${nodeId}:missing-propose`),
        ruleId: "HAR010",
        severity: "critical",
        message: `Commit tool node ${nodeId} is missing matching propose phaseGroup '${group}'.`,
        nodeId,
        promptPatch: {
          section: "tooling",
          operation: "append",
          content: `Add propose node for phaseGroup '${group}' before commit actions.`
        },
        resolutionSteps: [
          `Add tool node with sideEffectMode=propose and phaseGroup='${group}'.`,
          `Keep commit node ${nodeId} as sideEffectMode=commit with same phaseGroup.`,
          "Emit preview artifact hash before executing commit action."
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
