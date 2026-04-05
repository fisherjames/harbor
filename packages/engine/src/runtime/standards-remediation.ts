import fs from "node:fs";
import type { StandardsRemediationProvider, StandardsRemediationSnapshot } from "../contracts/runtime.js";

interface RemediationReportPayload {
  promptSection?: string;
}

export function createFileStandardsRemediationProvider(reportPath: string): StandardsRemediationProvider {
  return {
    async load(): Promise<StandardsRemediationSnapshot | null> {
      try {
        const raw = fs.readFileSync(reportPath, "utf8");
        const parsed = JSON.parse(raw) as RemediationReportPayload;
        const promptSection = parsed.promptSection?.trim() ?? "";

        if (promptSection.length === 0) {
          return null;
        }

        return {
          sourcePath: reportPath,
          promptSection
        };
      } catch {
        return null;
      }
    }
  };
}
