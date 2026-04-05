import { describe, expect, it } from "vitest";
import { sampleWorkflow } from "../src/lib/sample-workflow";

describe("sampleWorkflow", () => {
  it("contains required verifier stage and memory policy", () => {
    expect(sampleWorkflow.nodes.some((node) => node.type === "verifier")).toBe(true);
    expect(sampleWorkflow.memoryPolicy?.retrievalMode).toBe("monitor");
  });
});
