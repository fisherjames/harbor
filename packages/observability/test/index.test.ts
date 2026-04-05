import { describe, expect, it } from "vitest";
import { createRunTracer } from "../src/index.js";

describe("createRunTracer", () => {
  it("handles stage and finding events without throwing", () => {
    const tracer = createRunTracer("harbor-test");

    expect(() => {
      tracer.stageStart({ runId: "r1", workflowId: "wf", stage: "plan", message: "start", metadata: { a: 1 } });
      tracer.stageEnd({ runId: "r1", workflowId: "wf", stage: "plan", message: "end" });
      tracer.finding({ runId: "r1", workflowId: "wf", message: "warn" });
    }).not.toThrow();
  });

  it("records errors without throwing", () => {
    const tracer = createRunTracer("harbor-test");

    expect(() => {
      tracer.error({
        runId: "r1",
        workflowId: "wf",
        message: "error",
        error: new Error("boom")
      });
    }).not.toThrow();
  });
});
