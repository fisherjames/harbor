import { describe, expect, it } from "vitest";
import { assembleStagePrompt, DEFAULT_STAGE_DIRECTIVES, type WorkflowDefinition } from "../src/index.js";

const workflow: WorkflowDefinition = {
  id: "wf_1",
  name: "Example",
  version: 1,
  objective: "Solve the task",
  systemPrompt: "system",
  memoryPolicy: {
    retrievalMode: "monitor",
    maxContextItems: 8,
    writebackEnabled: true,
    piiRetention: "redacted"
  },
  nodes: []
};

describe("assembleStagePrompt", () => {
  it("injects harness resolution steps", () => {
    const prompt = assembleStagePrompt({
      stage: "execute",
      workflow,
      baseTask: "Do the thing",
      memoryContext: "Prior runs and constraints",
      lintFindings: [
        {
          findingId: "HAR003:node",
          ruleId: "HAR003",
          severity: "warning",
          message: "Missing timeout",
          resolutionSteps: ["Add timeout budget"],
          promptPatch: {
            section: "constraints",
            operation: "append",
            content: "Set timeoutMs and retryLimit"
          }
        }
      ]
    });

    expect(prompt).toContain("## Harness Resolution Steps");
    expect(prompt).toContain("Apply these steps without changing the primary objective");
    expect(prompt).toContain("Add timeout budget");
    expect(prompt).toContain("## Constraints");
    expect(prompt).toContain("## Memory Context");
    expect(prompt).toContain("## Prompt Envelope");
    expect(prompt).toContain("### Platform System Prompt");
    expect(prompt).toContain("### Workflow System Prompt");
    expect(prompt).toContain("### Stage Directive");
  });

  it("uses explicit prompt envelope overrides when provided", () => {
    const prompt = assembleStagePrompt({
      stage: "plan",
      workflow,
      baseTask: "Plan work",
      platformSystemPrompt: "Platform policy override",
      workflowSystemPrompt: "Workflow policy override",
      stageDirective: "Custom planning directive"
    });

    expect(prompt).toContain("Platform policy override");
    expect(prompt).toContain("Workflow policy override");
    expect(prompt).toContain("Custom planning directive");
  });

  it("falls back to defaults when envelope overrides are blank", () => {
    const prompt = assembleStagePrompt({
      stage: "execute",
      workflow: {
        ...workflow,
        systemPrompt: "   "
      },
      baseTask: "Execute work",
      platformSystemPrompt: "   ",
      workflowSystemPrompt: "   ",
      stageDirective: "   "
    });

    expect(prompt).toContain("### Platform System Prompt\n(not provided)");
    expect(prompt).toContain("### Workflow System Prompt\n(not provided)");
    expect(prompt).toContain(DEFAULT_STAGE_DIRECTIVES.execute);
  });

  it("omits resolution and verifier sections when there are no lint findings", () => {
    const prompt = assembleStagePrompt({
      stage: "plan",
      workflow,
      baseTask: "Do the thing"
    });

    expect(prompt).not.toContain("## Harness Resolution Steps");
    expect(prompt).not.toContain("## Verifier Checkpoint");
  });

  it("deduplicates resolution steps and renders replace patches explicitly", () => {
    const prompt = assembleStagePrompt({
      stage: "verify",
      workflow,
      baseTask: "Verify output",
      lintFindings: [
        {
          findingId: "HAR010:a",
          ruleId: "HAR010",
          severity: "warning",
          message: "Constraint missing",
          resolutionSteps: ["Use bounded scope", "Use bounded scope", "   "],
          promptPatch: {
            section: "constraints",
            operation: "replace",
            content: "Always enforce bounded scope."
          }
        }
      ]
    });

    expect(prompt).toContain("Replace existing guidance with: Always enforce bounded scope.");
    expect(prompt.split("Use bounded scope").length - 1).toBe(1);
  });

  it("appends remediation prompt section content into harness resolution steps", () => {
    const prompt = assembleStagePrompt({
      stage: "execute",
      workflow,
      baseTask: "Do the thing",
      lintFindings: [
        {
          findingId: "HAR003:node",
          ruleId: "HAR003",
          severity: "warning",
          message: "Missing timeout",
          resolutionSteps: ["Add timeout budget"]
        }
      ],
      resolutionSectionAppendix:
        "## Harness Resolution Steps\nApply these steps without changing the primary objective:\n1. Resolve repeated drift signals."
    });

    expect(prompt).toContain("## Harness Resolution Steps");
    expect(prompt).toContain("Add timeout budget");
    expect(prompt).toContain("Resolve repeated drift signals.");
    expect(prompt.match(/## Harness Resolution Steps/g)).toHaveLength(1);
  });

  it("renders only appendix section when lint findings are absent", () => {
    const prompt = assembleStagePrompt({
      stage: "verify",
      workflow,
      baseTask: "Verify output",
      resolutionSectionAppendix: "Run standards trend remediation checklist before final response."
    });

    expect(prompt).toContain("## Harness Resolution Steps");
    expect(prompt).toContain("Run standards trend remediation checklist before final response.");
  });
});
