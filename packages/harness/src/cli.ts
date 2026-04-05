import fs from "node:fs";
import path from "node:path";
import { lintWorkflowDefinition } from "./linter.js";
import type { WorkflowDefinition } from "./types.js";

async function main(): Promise<void> {
  const workflowFile = process.argv[2];
  if (!workflowFile) {
    console.error("Usage: harbor-harness-lint <workflow.json>");
    process.exit(1);
  }

  const workflowPath = path.resolve(workflowFile);
  const raw = fs.readFileSync(workflowPath, "utf8");
  const workflow = JSON.parse(raw) as WorkflowDefinition;

  const report = lintWorkflowDefinition(workflow);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (report.blocked) {
    process.exit(2);
  }
}

void main();
