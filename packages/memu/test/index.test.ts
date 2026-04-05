import { describe, expect, it } from "vitest";
import { createMemuClient } from "../src/index.js";

describe("createMemuClient", () => {
  it("creates a client instance", () => {
    const client = createMemuClient({ endpoint: "https://memu.example" });
    expect(client).toBeDefined();
  });

  it("rejects empty endpoints", () => {
    expect(() => createMemuClient({ endpoint: "" })).toThrow("endpoint is required");
  });
});
