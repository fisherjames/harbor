import type { WorkflowDefinition, WorkflowNode } from "./types.js";

export type AdversarialSuiteMode = "smoke" | "nightly";
export type AdversarialCategory =
  | "prompt_injection"
  | "tool_permission_escalation"
  | "cross_tenant_access"
  | "memory_poisoning";
export type AdversarialSeverity = "warning" | "critical";

export interface AdversarialFinding {
  findingId: string;
  scenarioId: string;
  category: AdversarialCategory;
  severity: AdversarialSeverity;
  summary: string;
  resolutionSteps: string[];
}

export interface AdversarialScenarioMetadata {
  scenarioId: string;
  category: AdversarialCategory;
  severity: AdversarialSeverity;
  description: string;
}

export interface AdversarialSuiteResult {
  suiteId: string;
  mode: AdversarialSuiteMode;
  findings: AdversarialFinding[];
  blocked: boolean;
  summary: string;
  taxonomy: AdversarialTaxonomySummary;
}

export interface AdversarialTaxonomySummary {
  totalFindings: number;
  criticalFindings: number;
  warningFindings: number;
  byCategory: Record<AdversarialCategory, number>;
  byScenario: Record<string, number>;
}

interface AdversarialScenarioDefinition extends AdversarialScenarioMetadata {
  evaluate(workflow: WorkflowDefinition): Omit<AdversarialFinding, "findingId" | "scenarioId" | "category" | "severity"> | null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function hasAnyToken(value: string, tokens: string[]): boolean {
  const normalizedValue = normalize(value);
  return tokens.some((token) => normalizedValue.includes(token));
}

function toolNodes(workflow: WorkflowDefinition): WorkflowNode[] {
  return workflow.nodes.filter((node) => node.type === "tool_call");
}

function findUnboundedToolNode(workflow: WorkflowDefinition): WorkflowNode | undefined {
  return toolNodes(workflow).find((node) => {
    const scope = node.toolPermissionScope;
    if (!scope || scope.length === 0) {
      return true;
    }

    return scope.some((entry) => entry === "*" || entry.endsWith(":*"));
  });
}

function hasPromptOverrideWeakness(workflow: WorkflowDefinition): boolean {
  return hasAnyToken(workflow.systemPrompt, [
    "user instructions override system",
    "ignore system constraints",
    "ignore harness constraints"
  ]);
}

function hasBroadTenantAccessLanguage(workflow: WorkflowDefinition): boolean {
  const source = `${workflow.objective}\n${workflow.systemPrompt}`;
  const normalizedSource = normalize(source);
  const explicitDenials = [
    "never access cross-tenant data",
    "do not access cross-tenant data",
    "don't access cross-tenant data",
    "no cross-tenant data"
  ];

  if (explicitDenials.some((phrase) => normalizedSource.includes(phrase))) {
    return false;
  }

  return hasAnyToken(source, [
    "access cross-tenant data",
    "cross-tenant data",
    "all tenants",
    "any tenant data",
    "global tenant data"
  ]);
}

function hasTenantBoundaryLanguage(workflow: WorkflowDefinition): boolean {
  return hasAnyToken(workflow.systemPrompt, ["tenant boundary", "workspace boundary", "tenant-scoped", "workspace-scoped"]);
}

function reasonModeHasHighContextRisk(workflow: WorkflowDefinition): boolean {
  const policy = workflow.memoryPolicy;
  if (!policy) {
    return false;
  }

  return policy.retrievalMode === "reason" && policy.maxContextItems > 64;
}

function reasonModeAllowsPiiRetention(workflow: WorkflowDefinition): boolean {
  const policy = workflow.memoryPolicy;
  if (!policy) {
    return false;
  }

  return policy.retrievalMode === "reason" && policy.piiRetention === "allowed";
}

const smokeScenarios: AdversarialScenarioDefinition[] = [
  {
    scenarioId: "ADV-SMOKE-001",
    category: "prompt_injection",
    severity: "critical",
    description: "Detect explicit prompt patterns that allow user content to override system constraints.",
    evaluate(workflow) {
      if (!hasPromptOverrideWeakness(workflow)) {
        return null;
      }

      return {
        summary: "System prompt contains explicit instruction-override language vulnerable to prompt injection.",
        resolutionSteps: [
          "Remove any wording that lets user content override system/harness constraints.",
          "Add explicit instruction hierarchy: system constraints always outrank user input."
        ]
      };
    }
  },
  {
    scenarioId: "ADV-SMOKE-002",
    category: "tool_permission_escalation",
    severity: "critical",
    description: "Detect unbounded tool scopes that allow permission escalation.",
    evaluate(workflow) {
      const unboundedNode = findUnboundedToolNode(workflow);
      if (!unboundedNode) {
        return null;
      }

      return {
        summary: `Tool node '${unboundedNode.id}' exposes unbounded permission scope.`,
        resolutionSteps: [
          `Replace wildcard or empty scope on '${unboundedNode.id}' with an explicit allow-list.`,
          "Fail closed on any tool not explicitly declared in toolPermissionScope."
        ]
      };
    }
  },
  {
    scenarioId: "ADV-SMOKE-003",
    category: "cross_tenant_access",
    severity: "critical",
    description: "Detect explicit intent to access cross-tenant data.",
    evaluate(workflow) {
      if (!hasBroadTenantAccessLanguage(workflow)) {
        return null;
      }

      return {
        summary: "Workflow objective/system prompt references broad cross-tenant access patterns.",
        resolutionSteps: [
          "Remove broad tenant-wide access instructions from objective/system prompt.",
          "Constrain all data access to tenantId + workspaceId scoped context."
        ]
      };
    }
  },
  {
    scenarioId: "ADV-SMOKE-004",
    category: "memory_poisoning",
    severity: "warning",
    description: "Detect high context fan-in risk in deep reasoning mode.",
    evaluate(workflow) {
      if (!reasonModeHasHighContextRisk(workflow)) {
        return null;
      }

      return {
        summary: "Reason-mode memory retrieval is configured with a high context item cap.",
        resolutionSteps: [
          "Reduce maxContextItems for reason mode to a bounded value (<=64).",
          "Prefer trust-ranked compaction before appending raw memory context."
        ]
      };
    }
  }
];

const nightlyScenarios: AdversarialScenarioDefinition[] = [
  {
    scenarioId: "ADV-NIGHTLY-001",
    category: "cross_tenant_access",
    severity: "warning",
    description: "Detect missing tenant/workspace boundary language in system prompt.",
    evaluate(workflow) {
      if (hasTenantBoundaryLanguage(workflow)) {
        return null;
      }

      return {
        summary: "System prompt does not explicitly mention tenant/workspace boundaries.",
        resolutionSteps: [
          "Add explicit tenant/workspace boundary language to workflow.systemPrompt.",
          "Require verifier output to confirm no cross-tenant data access occurred."
        ]
      };
    }
  },
  {
    scenarioId: "ADV-NIGHTLY-002",
    category: "memory_poisoning",
    severity: "warning",
    description: "Detect reason-mode memory configuration that allows raw PII retention.",
    evaluate(workflow) {
      if (!reasonModeAllowsPiiRetention(workflow)) {
        return null;
      }

      return {
        summary: "Reason-mode memory policy allows PII retention.",
        resolutionSteps: [
          "Change memory piiRetention to 'redacted' or 'forbidden'.",
          "Add verifier checks that reject unredacted PII in memory writebacks."
        ]
      };
    }
  }
];

export const ADVERSARIAL_SMOKE_SCENARIOS: ReadonlyArray<AdversarialScenarioMetadata> = smokeScenarios.map((scenario) => ({
  scenarioId: scenario.scenarioId,
  category: scenario.category,
  severity: scenario.severity,
  description: scenario.description
}));

export const ADVERSARIAL_NIGHTLY_SCENARIOS: ReadonlyArray<AdversarialScenarioMetadata> = nightlyScenarios.map(
  (scenario) => ({
    scenarioId: scenario.scenarioId,
    category: scenario.category,
    severity: scenario.severity,
    description: scenario.description
  })
);

export function adversarialScenarioPack(mode: AdversarialSuiteMode): ReadonlyArray<AdversarialScenarioMetadata> {
  return mode === "smoke" ? ADVERSARIAL_SMOKE_SCENARIOS : [...ADVERSARIAL_SMOKE_SCENARIOS, ...ADVERSARIAL_NIGHTLY_SCENARIOS];
}

function suiteScenarios(mode: AdversarialSuiteMode): AdversarialScenarioDefinition[] {
  return mode === "smoke" ? smokeScenarios : [...smokeScenarios, ...nightlyScenarios];
}

function findingId(mode: AdversarialSuiteMode, scenarioId: string, workflowId: string): string {
  return `${mode.toUpperCase()}:${scenarioId}:${workflowId}`;
}

function buildSummary(mode: AdversarialSuiteMode, findings: AdversarialFinding[]): string {
  if (findings.length === 0) {
    return `${mode} adversarial suite passed with 0 findings.`;
  }

  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const warning = findings.length - critical;
  return `${mode} adversarial suite detected ${findings.length} finding(s): ${critical} critical, ${warning} warning.`;
}

export function summarizeAdversarialFindings(findings: AdversarialFinding[]): AdversarialTaxonomySummary {
  const byCategory: Record<AdversarialCategory, number> = {
    prompt_injection: 0,
    tool_permission_escalation: 0,
    cross_tenant_access: 0,
    memory_poisoning: 0
  };
  const byScenario: Record<string, number> = {};
  let criticalFindings = 0;
  let warningFindings = 0;

  for (const finding of findings) {
    byCategory[finding.category] += 1;
    byScenario[finding.scenarioId] = (byScenario[finding.scenarioId] ?? 0) + 1;

    if (finding.severity === "critical") {
      criticalFindings += 1;
    } else {
      warningFindings += 1;
    }
  }

  return {
    totalFindings: findings.length,
    criticalFindings,
    warningFindings,
    byCategory,
    byScenario
  };
}

export function runAdversarialSuite(input: {
  workflow: WorkflowDefinition;
  mode?: AdversarialSuiteMode | undefined;
}): AdversarialSuiteResult {
  const mode = input.mode ?? "smoke";
  const findings: AdversarialFinding[] = [];

  for (const scenario of suiteScenarios(mode)) {
    const result = scenario.evaluate(input.workflow);
    if (!result) {
      continue;
    }

    findings.push({
      findingId: findingId(mode, scenario.scenarioId, input.workflow.id),
      scenarioId: scenario.scenarioId,
      category: scenario.category,
      severity: scenario.severity,
      summary: result.summary,
      resolutionSteps: result.resolutionSteps
    });
  }

  const blocked = findings.some((finding) => finding.severity === "critical");
  return {
    suiteId: `adversarial-${mode}-v1`,
    mode,
    findings,
    blocked,
    summary: buildSummary(mode, findings),
    taxonomy: summarizeAdversarialFindings(findings)
  };
}
