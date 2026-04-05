import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStandardsRemediationProvider } from "../src/index.js";

const tempDirs: string[] = [];

function createTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-remediation-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("createFileStandardsRemediationProvider", () => {
  it("returns null when report path is missing", async () => {
    const provider = createFileStandardsRemediationProvider("/tmp/harbor/missing-remediation.json");
    await expect(provider.load()).resolves.toBeNull();
  });

  it("returns null when promptSection is empty", async () => {
    const filePath = createTempFile("remediation.json", JSON.stringify({ version: 1, promptSection: "   " }));
    const provider = createFileStandardsRemediationProvider(filePath);

    await expect(provider.load()).resolves.toBeNull();
  });

  it("returns null when promptSection is absent", async () => {
    const filePath = createTempFile("remediation.json", JSON.stringify({ version: 1 }));
    const provider = createFileStandardsRemediationProvider(filePath);

    await expect(provider.load()).resolves.toBeNull();
  });

  it("returns snapshot when promptSection is present", async () => {
    const filePath = createTempFile(
      "remediation.json",
      JSON.stringify({ version: 1, promptSection: "  ## Harness Resolution Steps\n1. Fix drift  " })
    );
    const provider = createFileStandardsRemediationProvider(filePath);

    await expect(provider.load()).resolves.toEqual({
      sourcePath: filePath,
      promptSection: "## Harness Resolution Steps\n1. Fix drift"
    });
  });
});
