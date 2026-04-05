import type { RemediationRecommendation } from "../types.js";

export const HAR_RULE_IDS = ["HAR001", "HAR002", "HAR003", "HAR004", "HAR005"] as const;

export type HarRuleId = (typeof HAR_RULE_IDS)[number];

export const HAR_TEMPLATE_TARGET_BY_RULE: Record<
  HarRuleId,
  RemediationRecommendation["templateTarget"]
> = {
  HAR001: "verification",
  HAR002: "tooling",
  HAR003: "budgeting",
  HAR004: "memory",
  HAR005: "tooling"
};

export const HAR_REMEDIATION_SUGGESTION_BY_RULE: Record<HarRuleId, string> = {
  HAR001: "Promote verifier-node template with explicit PASS/FAIL acceptance checks.",
  HAR002: "Promote least-privilege tool allow-list policy template.",
  HAR003: "Promote default timeout/retry budget template for every workflow node.",
  HAR004: "Promote standard memU policy template with bounded retrieval and PII retention.",
  HAR005: "Promote per-tool timeout/retry/max-call budget templates for tool nodes."
};

export function isHarRuleId(ruleId: string): ruleId is HarRuleId {
  return HAR_RULE_IDS.includes(ruleId as HarRuleId);
}
