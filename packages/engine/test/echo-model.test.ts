import { describe, expect, it } from "vitest";
import { EchoModelProvider } from "../src/index.js";

describe("EchoModelProvider", () => {
  it("returns verification pass content for verify stage", async () => {
    const model = new EchoModelProvider();

    const result = await model.generate({
      stage: "verify",
      prompt: "check",
      context: {
        runId: "run",
        request: {
          tenantId: "t",
          workspaceId: "w",
          workflowId: "wf",
          trigger: "manual",
          input: {},
          actorId: "u"
        },
        workflow: {
          id: "wf",
          name: "name",
          version: 1,
          objective: "obj",
          systemPrompt: "sys",
          nodes: []
        }
      }
    });

    expect(result.output).toContain("PASS");
    expect(result.tokenUsage?.totalTokens).toBeGreaterThan(0);
  });

  it("returns stage-aware output for non-verify stages", async () => {
    const model = new EchoModelProvider();

    const result = await model.generate({
      stage: "plan",
      prompt: "make plan",
      context: {
        runId: "run",
        request: {
          tenantId: "t",
          workspaceId: "w",
          workflowId: "wf",
          trigger: "manual",
          input: {},
          actorId: "u"
        },
        workflow: {
          id: "wf",
          name: "name",
          version: 1,
          objective: "obj",
          systemPrompt: "sys",
          nodes: []
        }
      }
    });

    expect(result.output).toContain("Stage plan complete");
  });
});
