import { describe, expect, it } from "vitest";
import { withRetry } from "../src/runtime/retry.js";

describe("withRetry", () => {
  it("returns on first success", async () => {
    const result = await withRetry(async () => "ok", 2, 1);
    expect(result).toEqual({ value: "ok", attempts: 1 });
  });

  it("retries and eventually throws", async () => {
    await expect(
      withRetry(async () => {
        throw new Error("boom");
      }, 1, 1)
    ).rejects.toThrow("boom");
  });
});
