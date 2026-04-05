import { describe, expect, it } from "vitest";
import { resolveTrpcUrl, sampleWorkflow } from "../src/index";

describe("web barrel exports", () => {
  it("re-exports helpers", () => {
    expect(resolveTrpcUrl("https://example.com")).toBe("https://example.com/api/trpc");
    expect(sampleWorkflow.id).toBe("wf_demo");
  });
});
