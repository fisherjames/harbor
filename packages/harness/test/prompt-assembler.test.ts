import { describe, expect, it } from "vitest";
import { assembleStagePrompt, type WorkflowDefinition } from "../src/index.js";

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
});
