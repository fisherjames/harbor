#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function resolve(relativePath) {
  return path.join(root, relativePath);
}

function fileExists(relativePath) {
  return fs.existsSync(resolve(relativePath));
}

function ensureDir(relativePath) {
  fs.mkdirSync(resolve(relativePath), { recursive: true });
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(resolve(relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(resolve(relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toDateString(isoTimestamp) {
  return new Date(isoTimestamp).toISOString().slice(0, 10);
}

const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

const contractPath = "docs/strategy/adversarial-taxonomy-contract.json";
if (!fileExists(contractPath)) {
  console.error(`FAIL Missing ${contractPath}`);
  process.exit(1);
}

const contract = readJson(contractPath);
for (const requiredFile of contract.requiredFiles ?? []) {
  if (!fileExists(requiredFile)) {
    fail(`Adversarial taxonomy drift: missing required file '${requiredFile}'`);
  } else {
    pass(`Required file exists: ${requiredFile}`);
  }
}

if (failures.length > 0) {
  console.log("");
  console.log("Adversarial Taxonomy Check Summary");
  console.log(`- Failures: ${failures.length}`);
  console.log(`- Warnings: ${warnings.length}`);
  console.log("");
  console.log("Failures:");
  for (const message of failures) {
    console.log(`- ${message}`);
  }
  process.exit(1);
}

execSync("pnpm --filter @harbor/harness build", {
  cwd: root,
  stdio: "ignore"
});
pass("Built @harbor/harness for deterministic nightly adversarial evaluation");

const harnessModulePath = pathToFileURL(resolve("packages/harness/dist/index.js")).href;
const harnessModule = await import(harnessModulePath);
const runAdversarialSuite = harnessModule.runAdversarialSuite;

if (typeof runAdversarialSuite !== "function") {
  console.error("FAIL Unable to resolve runAdversarialSuite from @harbor/harness");
  process.exit(1);
}

const fixturesPath = "docs/adversarial/workflows/nightly-fixtures.json";
const fixturesPayload = readJson(fixturesPath);
const fixtures = Array.isArray(fixturesPayload.fixtures) ? fixturesPayload.fixtures : [];

if (fixtures.length === 0) {
  fail("Adversarial taxonomy drift: nightly fixtures cannot be empty");
}

const requiredCategories = Array.isArray(contract.requiredCategories)
  ? contract.requiredCategories.map(String)
  : ["prompt_injection", "tool_permission_escalation", "cross_tenant_access", "memory_poisoning"];

const totals = {
  totalFindings: 0,
  criticalFindings: 0,
  warningFindings: 0,
  byCategory: Object.fromEntries(requiredCategories.map((category) => [category, 0])),
  byScenario: {}
};
const workflowReports = [];

for (const fixture of fixtures) {
  const suite = runAdversarialSuite({
    workflow: fixture.workflow,
    mode: "nightly"
  });

  totals.totalFindings += suite.taxonomy.totalFindings;
  totals.criticalFindings += suite.taxonomy.criticalFindings;
  totals.warningFindings += suite.taxonomy.warningFindings;

  for (const [category, count] of Object.entries(suite.taxonomy.byCategory)) {
    if (!(category in totals.byCategory)) {
      warn(`Unexpected adversarial category '${category}' encountered in taxonomy`);
      totals.byCategory[category] = 0;
    }
    totals.byCategory[category] += count;
  }

  for (const [scenarioId, count] of Object.entries(suite.taxonomy.byScenario)) {
    totals.byScenario[scenarioId] = (totals.byScenario[scenarioId] ?? 0) + count;
  }

  workflowReports.push({
    tenantId: fixture.tenantId,
    workspaceId: fixture.workspaceId,
    workflowId: fixture.workflow.id,
    workflowVersion: fixture.workflow.version,
    blocked: suite.blocked,
    summary: suite.summary,
    findings: suite.findings.length,
    taxonomy: suite.taxonomy
  });
}

for (const category of requiredCategories) {
  if (!(category in totals.byCategory)) {
    fail(`Adversarial taxonomy drift: required category '${category}' missing from aggregate report`);
  }
}

const generatedAt = new Date().toISOString();
const blockedWorkflowCount = workflowReports.filter((workflow) => workflow.blocked).length;
const report = {
  generatedAt,
  suiteId: "adversarial-nightly-report-v1",
  mode: "nightly",
  workflowCount: workflowReports.length,
  blockedWorkflowCount,
  taxonomy: totals,
  workflows: workflowReports,
  generatedBy: "scripts/adversarial-taxonomy-check.mjs"
};

writeJson("docs/adversarial/reports/latest.json", report);
pass("Updated docs/adversarial/reports/latest.json");

ensureDir("docs/adversarial/reports/history");
const historyFilename = `${toDateString(generatedAt)}.json`;
writeJson(`docs/adversarial/reports/history/${historyFilename}`, report);
pass(`Updated adversarial history snapshot: ${historyFilename}`);

const historyIndexPath = "docs/adversarial/reports/history/index.json";
const historyIndex = fileExists(historyIndexPath) ? readJson(historyIndexPath) : { entries: [] };
const historyEntries = Array.isArray(historyIndex.entries) ? historyIndex.entries.map(String) : [];
if (!historyEntries.includes(historyFilename)) {
  historyEntries.push(historyFilename);
}

const retentionDays =
  typeof contract.historyRetentionDays === "number" && contract.historyRetentionDays > 0
    ? contract.historyRetentionDays
    : 45;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const retainedEntries = historyEntries
  .sort()
  .filter((entry) => {
    const entryDate = new Date(`${entry.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(entryDate.getTime())) {
      warn(`Ignoring malformed adversarial history entry '${entry}'`);
      return false;
    }

    const ageDays = (Date.now() - entryDate.getTime()) / millisecondsPerDay;
    if (ageDays > retentionDays) {
      const entryPath = `docs/adversarial/reports/history/${entry}`;
      if (fileExists(entryPath)) {
        fs.unlinkSync(resolve(entryPath));
        pass(`Pruned adversarial history entry '${entry}' by retention policy`);
      }
      return false;
    }

    return true;
  });
writeJson(historyIndexPath, { entries: retainedEntries });
pass(`Updated ${historyIndexPath}`);

if (blockedWorkflowCount > 0) {
  fail(
    `Adversarial nightly gate failed: ${blockedWorkflowCount} workflow(s) contain critical vulnerabilities.`
  );
}

console.log("");
console.log("Adversarial Taxonomy Check Summary");
console.log(`- Failures: ${failures.length}`);
console.log(`- Warnings: ${warnings.length}`);

if (warnings.length > 0) {
  console.log("");
  console.log("Warnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

if (failures.length > 0) {
  console.log("");
  console.log("Failures:");
  for (const message of failures) {
    console.log(`- ${message}`);
  }
  process.exit(1);
}

console.log("");
console.log("Adversarial nightly taxonomy is in sync and no critical vulnerabilities were detected.");
