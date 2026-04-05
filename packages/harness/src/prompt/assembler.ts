import type { AssemblePromptInput, LintFinding, PromptPatch } from "../types.js";

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

  const content = patches.map((patch) => `- ${patch.content}`).join("\n");
  return `## ${titleBySection[section]}\n${content}`;
}

function injectHarnessResolutionSteps(findings: LintFinding[]): string {
  if (findings.length === 0) {
    return "";
  }

  const steps = findings
    .flatMap((finding) => finding.resolutionSteps)
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");

  return `## Harness Resolution Steps\n${steps}`;
}

function buildVerifierCheckpoint(findings: LintFinding[]): string {
  if (findings.length === 0) {
    return "";
  }

  const constraints = findings.map((finding) => `- [ ] ${finding.ruleId}: ${finding.message}`).join("\n");

  return `## Verifier Checkpoint\nConfirm these constraints have been addressed:\n${constraints}`;
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
    `## Objective\n${input.workflow.objective}`,
    `## Task\n${input.baseTask}`,
    input.memoryContext ? `## Memory Context\n${input.memoryContext}` : "",
    renderPatchBlock("constraints", constraints),
    renderPatchBlock("verification", verification),
    renderPatchBlock("tooling", tooling),
    renderPatchBlock("memory", memory),
    injectHarnessResolutionSteps(lintFindings),
    buildVerifierCheckpoint(lintFindings)
  ];

  return sections.filter(Boolean).join("\n\n");
}
