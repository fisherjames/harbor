import type { AssemblePromptInput, LintFinding, PromptPatch, PromptStage } from "../types.js";

export const DEFAULT_PLATFORM_SYSTEM_PROMPT =
  "You are Harbor runtime. Follow harness constraints, enforce tenancy boundaries, and return concise actionable outputs.";

export const DEFAULT_STAGE_DIRECTIVES: Record<PromptStage, string> = {
  plan:
    "Build a bounded execution plan with explicit assumptions, dependencies, and success criteria. Return confidence (0-1) and optional rationale.",
  execute: "Execute the approved plan, use only allowed tools, and persist relevant artifacts.",
  verify:
    "Validate outputs against objective and constraints, then return explicit PASS or FAIL with evidence plus confidence (0-1) and optional rationale.",
  fix:
    "Apply the minimal correction needed to address verification failures before re-verification, and return confidence (0-1) with optional rationale."
};

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function normalizePromptValue(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "(not provided)";
}

export function resolveStageDirective(stage: PromptStage, override?: string): string {
  const normalizedOverride = (override ?? "").trim();
  if (normalizedOverride.length > 0) {
    return normalizedOverride;
  }

  return DEFAULT_STAGE_DIRECTIVES[stage];
}

function renderPromptEnvelope(input: AssemblePromptInput): string {
  const platformSystemPrompt = normalizePromptValue(input.platformSystemPrompt ?? DEFAULT_PLATFORM_SYSTEM_PROMPT);
  const workflowSystemPrompt = normalizePromptValue(input.workflowSystemPrompt ?? input.workflow.systemPrompt);
  const stageDirective = resolveStageDirective(input.stage, input.stageDirective);

  return [
    "## Prompt Envelope",
    "### Platform System Prompt",
    platformSystemPrompt,
    "### Workflow System Prompt",
    workflowSystemPrompt,
    "### Stage Directive",
    stageDirective
  ].join("\n");
}

function renderPatchBlock(section: PromptPatch["section"], patches: PromptPatch[]): string {
  if (patches.length === 0) {
    return "";
  }

  const titleBySection: Record<PromptPatch["section"], string> = {
    constraints: "Constraints",
    verification: "Verification",
    tooling: "Tooling",
    memory: "Memory"
  };

  const content = patches
    .map((patch) =>
      patch.operation === "replace" ? `- Replace existing guidance with: ${patch.content}` : `- ${patch.content}`
    )
    .join("\n");
  return `## ${titleBySection[section]}\n${content}`;
}

function normalizeResolutionAppendix(section: string): string {
  const trimmed = section.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const lines = trimmed.split(/\r?\n/);
  if (lines[0]?.trim().toLowerCase() === "## harness resolution steps") {
    return lines.slice(1).join("\n").trim();
  }

  return trimmed;
}

function injectHarnessResolutionSteps(findings: LintFinding[], sectionAppendix?: string): string {
  const steps = uniquePreserveOrder(
    findings.flatMap((finding) => finding.resolutionSteps).filter((step) => step.trim().length > 0)
  );
  const renderedSteps = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  const appendix = normalizeResolutionAppendix(sectionAppendix ?? "");

  if (renderedSteps.length === 0 && appendix.length === 0) {
    return "";
  }

  const sections: string[] = [];
  if (renderedSteps.length > 0) {
    sections.push(`Apply these steps without changing the primary objective:\n${renderedSteps}`);
  }
  if (appendix.length > 0) {
    sections.push(appendix);
  }

  return `## Harness Resolution Steps\n${sections.join("\n\n")}`;
}

function buildVerifierCheckpoint(findings: LintFinding[]): string {
  if (findings.length === 0) {
    return "";
  }

  const constraints = uniquePreserveOrder(
    findings.map((finding) => `- [ ] ${finding.ruleId}: ${finding.message}`)
  ).join("\n");

  return `## Verifier Checkpoint\nConfirm each item before reporting PASS:\n${constraints}`;
}

export function assembleStagePrompt(input: AssemblePromptInput): string {
  const lintFindings = input.lintFindings ?? [];
  const lintPatches = lintFindings
    .filter((finding) => finding.promptPatch)
    .map((finding) => finding.promptPatch as PromptPatch);

  const constraints = lintPatches.filter((patch) => patch.section === "constraints");
  const verification = lintPatches.filter((patch) => patch.section === "verification");
  const tooling = lintPatches.filter((patch) => patch.section === "tooling");
  const memory = lintPatches.filter((patch) => patch.section === "memory");

  const sections = [
    `# Harbor Harness Prompt\nStage: ${input.stage}`,
    renderPromptEnvelope(input),
    `## Objective\n${input.workflow.objective}`,
    `## Task\n${input.baseTask}`,
    input.memoryContext ? `## Memory Context\n${input.memoryContext}` : "",
    renderPatchBlock("constraints", constraints),
    renderPatchBlock("verification", verification),
    renderPatchBlock("tooling", tooling),
    renderPatchBlock("memory", memory),
    injectHarnessResolutionSteps(lintFindings, input.resolutionSectionAppendix),
    buildVerifierCheckpoint(lintFindings)
  ];

  return sections.filter(Boolean).join("\n\n");
}
