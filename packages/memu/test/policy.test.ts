import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_POLICY, validateMemoryPolicy } from "../src/index.js";

describe("validateMemoryPolicy", () => {
  it("accepts the default policy", () => {
    expect(validateMemoryPolicy(DEFAULT_MEMORY_POLICY)).toEqual({ valid: true, errors: [] });
  });

  it("rejects invalid maxContextItems", () => {
    const result = validateMemoryPolicy({
      retrievalMode: "monitor",
      maxContextItems: 0,
      writebackEnabled: true,
      piiRetention: "redacted"
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("maxContextItems");
  });
});
