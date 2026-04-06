#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

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

function round4(value) {
  return Math.round(value * 10_000) / 10_000;
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

const contractPath = "docs/strategy/evaluator-calibration-contract.json";
if (!fileExists(contractPath)) {
  console.error(`FAIL Missing ${contractPath}`);
  process.exit(1);
}

const contract = readJson(contractPath);
for (const requiredFile of contract.requiredFiles ?? []) {
  if (!fileExists(requiredFile)) {
    fail(`Evaluator calibration drift: missing required file '${requiredFile}'`);
  } else {
    pass(`Required file exists: ${requiredFile}`);
  }
}

if (failures.length > 0) {
  console.log("");
  console.log("Evaluator Calibration Check Summary");
  console.log(`- Failures: ${failures.length}`);
  console.log(`- Warnings: ${warnings.length}`);
  console.log("");
  console.log("Failures:");
  for (const message of failures) {
    console.log(`- ${message}`);
  }
  process.exit(1);
}

const rubricPath = "docs/evaluator/rubric.json";
const benchmarkPath = "docs/evaluator/benchmarks/shared-benchmark.json";
const latestPath = "docs/evaluator/reports/latest.json";
const historyDir = "docs/evaluator/reports/history";
const historyIndexPath = `${historyDir}/index.json`;

const rubric = readJson(rubricPath);
for (const key of contract.requiredRubricKeys ?? []) {
  if (!(key in rubric)) {
    fail(`Evaluator calibration drift: rubric is missing key '${key}'`);
  } else {
    pass(`Rubric key present: ${key}`);
  }
}

const benchmark = readJson(benchmarkPath);
const observations = Array.isArray(benchmark.observations) ? benchmark.observations : [];
if (observations.length === 0) {
  fail("Evaluator calibration drift: benchmark observations cannot be empty");
}

if (rubric.benchmarkSetId !== benchmark.benchmarkSetId) {
  fail(
    `Evaluator calibration drift: rubric benchmarkSetId '${rubric.benchmarkSetId}' does not match benchmark '${benchmark.benchmarkSetId}'`
  );
} else {
  pass(`Benchmark set aligned: ${rubric.benchmarkSetId}`);
}

const nowIso = new Date().toISOString();
const calibratedAtDate = new Date(String(rubric.calibratedAt ?? ""));
if (Number.isNaN(calibratedAtDate.getTime())) {
  fail("Evaluator calibration drift: rubric calibratedAt is not a valid ISO timestamp");
}

const matches = observations.filter(
  (observation) => observation.expectedVerdict === observation.observedVerdict
).length;
const agreementScore = round4(observations.length === 0 ? 0 : matches / observations.length);
const driftScore = round4(1 - agreementScore);
const failingScenarioIds = observations
  .filter((observation) => observation.expectedVerdict !== observation.observedVerdict)
  .map((observation) => String(observation.scenarioId));
const minimumAgreement =
  typeof rubric.minimumAgreement === "number" ? round4(Math.max(0, Math.min(1, rubric.minimumAgreement))) : 0.85;
const maximumDrift =
  typeof rubric.maximumDrift === "number" ? round4(Math.max(0, Math.min(1, rubric.maximumDrift))) : 0.15;
const driftDetected = agreementScore < minimumAgreement || driftScore > maximumDrift;

const maxCalibrationAgeDays =
  typeof contract.maxCalibrationAgeDays === "number" && contract.maxCalibrationAgeDays > 0
    ? contract.maxCalibrationAgeDays
    : 31;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const daysSinceCalibration = round4((Date.now() - calibratedAtDate.getTime()) / millisecondsPerDay);

if (!Number.isFinite(daysSinceCalibration) || daysSinceCalibration < 0) {
  fail("Evaluator calibration drift: computed daysSinceCalibration is invalid");
}

if (daysSinceCalibration > maxCalibrationAgeDays) {
  fail(
    `Evaluator calibration drift: rubric age ${daysSinceCalibration} days exceeds max ${maxCalibrationAgeDays} days`
  );
} else {
  pass(`Rubric age ${daysSinceCalibration} days is within ${maxCalibrationAgeDays}-day policy`);
}

if (driftDetected) {
  fail(
    `Evaluator calibration drift: agreement ${agreementScore} / drift ${driftScore} violates thresholds ${minimumAgreement}/${maximumDrift}`
  );
} else {
  pass(`Evaluator drift check passed (agreement=${agreementScore}, drift=${driftScore})`);
}

const report = {
  generatedAt: nowIso,
  rubricVersion: String(rubric.rubricVersion ?? "rubric-unknown"),
  benchmarkSetId: String(rubric.benchmarkSetId ?? "benchmark-unknown"),
  calibratedAt: String(rubric.calibratedAt ?? ""),
  daysSinceCalibration,
  agreementScore,
  driftScore,
  minimumAgreement,
  maximumDrift,
  driftDetected,
  status: failures.length > 0 ? "failed" : "passed",
  failingScenarioIds,
  generatedBy: "scripts/evaluator-calibration-check.mjs"
};

writeJson(latestPath, report);
pass(`Updated ${latestPath}`);

ensureDir(historyDir);
const historyDateFile = `${toDateString(nowIso)}.json`;
writeJson(`${historyDir}/${historyDateFile}`, report);
pass(`Updated history report: ${historyDateFile}`);

const historyIndex = fileExists(historyIndexPath) ? readJson(historyIndexPath) : { entries: [] };
const historyEntries = Array.isArray(historyIndex.entries) ? historyIndex.entries.map(String) : [];
if (!historyEntries.includes(historyDateFile)) {
  historyEntries.push(historyDateFile);
}

historyEntries.sort();
const retentionDays =
  typeof contract.historyRetentionDays === "number" && contract.historyRetentionDays > 0
    ? contract.historyRetentionDays
    : 45;

const retainedEntries = historyEntries.filter((entry) => {
  const entryDate = new Date(`${entry.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(entryDate.getTime())) {
    warn(`Ignoring malformed history entry '${entry}'`);
    return false;
  }

  const ageDays = (Date.now() - entryDate.getTime()) / millisecondsPerDay;
  if (ageDays > retentionDays) {
    const entryPath = `${historyDir}/${entry}`;
    if (fileExists(entryPath)) {
      fs.unlinkSync(resolve(entryPath));
      pass(`Pruned retained history entry: ${entry}`);
    }
    return false;
  }

  return true;
});

writeJson(historyIndexPath, { entries: retainedEntries });
pass(`Updated ${historyIndexPath}`);

console.log("");
console.log("Evaluator Calibration Check Summary");
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
console.log("Evaluator calibration contract and drift thresholds are in sync.");
