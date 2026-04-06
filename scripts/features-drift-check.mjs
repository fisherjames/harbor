#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
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

const contractPath = "docs/strategy/features-contract.json";
if (!fileExists(contractPath)) {
  console.error(`FAIL Missing ${contractPath}`);
  process.exit(1);
}

if (!fileExists("docs/strategy/phase-tracker.json")) {
  console.error("FAIL Missing docs/strategy/phase-tracker.json");
  process.exit(1);
}

const contract = readJson(contractPath);
const phaseTracker = readJson("docs/strategy/phase-tracker.json");

for (const relativePath of contract.requiredDocuments ?? []) {
  if (!fileExists(relativePath)) {
    fail(`Feature drift: missing required document '${relativePath}'`);
  } else {
    pass(`Required feature document exists: ${relativePath}`);
  }
}

const featureCatalogPath = String(contract.featureCatalogPath ?? "");
if (!featureCatalogPath) {
  fail("Feature drift: contract is missing featureCatalogPath");
}

if (featureCatalogPath && !fileExists(featureCatalogPath)) {
  fail(`Feature drift: missing feature catalog '${featureCatalogPath}'`);
}

let featureCatalog = { features: [] };
if (featureCatalogPath && fileExists(featureCatalogPath)) {
  try {
    featureCatalog = readJson(featureCatalogPath);
    pass(`Loaded feature catalog: ${featureCatalogPath}`);
  } catch {
    fail(`Feature drift: invalid JSON in '${featureCatalogPath}'`);
  }
}

const phases = phaseTracker.phases ?? [];
const phaseStatusById = new Map(phases.map((phase) => [phase.id, phase.status]));

const allowedStatuses = new Set(contract.allowedStatuses ?? ["planned", "in_progress", "complete"]);
const features = Array.isArray(featureCatalog.features) ? featureCatalog.features : [];
if (!Array.isArray(featureCatalog.features)) {
  fail("Feature drift: catalog 'features' must be an array");
}

const featureIdSet = new Set();
const featureById = new Map();
for (const feature of features) {
  if (!feature || typeof feature !== "object") {
    fail("Feature drift: each feature entry must be an object");
    continue;
  }

  const id = String(feature.id ?? "").trim();
  const name = String(feature.name ?? "").trim();
  const phase = String(feature.phase ?? "").trim();
  const status = String(feature.status ?? "").trim();
  const summary = String(feature.summary ?? "").trim();
  const evidence = Array.isArray(feature.evidence) ? feature.evidence : [];

  if (!id) {
    fail("Feature drift: feature id is required");
    continue;
  }

  if (featureIdSet.has(id)) {
    fail(`Feature drift: duplicate feature id '${id}'`);
  } else {
    featureIdSet.add(id);
    featureById.set(id, feature);
    pass(`Feature id is unique: ${id}`);
  }

  if (!name) {
    fail(`Feature drift: feature '${id}' is missing name`);
  }

  if (!summary) {
    fail(`Feature drift: feature '${id}' is missing summary`);
  }

  if (!phaseStatusById.has(phase)) {
    fail(`Feature drift: feature '${id}' references unknown phase '${phase}'`);
  } else {
    pass(`Feature '${id}' maps to known phase ${phase}`);

    const phaseStatus = phaseStatusById.get(phase);
    if ((status === "in_progress" || status === "complete") && phaseStatus === "planned") {
      fail(`Feature drift: feature '${id}' is '${status}' but phase '${phase}' is still planned`);
    }
  }

  if (!allowedStatuses.has(status)) {
    fail(`Feature drift: feature '${id}' has invalid status '${status}'`);
  } else {
    pass(`Feature '${id}' status is allowed: ${status}`);
  }

  if (evidence.length === 0) {
    fail(`Feature drift: feature '${id}' must list at least one evidence path`);
  }

  for (const evidencePath of evidence) {
    const relativePath = String(evidencePath ?? "").trim();
    if (!relativePath) {
      fail(`Feature drift: feature '${id}' has empty evidence path`);
      continue;
    }

    if (!fileExists(relativePath)) {
      fail(`Feature drift: feature '${id}' evidence path is missing '${relativePath}'`);
    } else {
      pass(`Feature '${id}' evidence exists: ${relativePath}`);
    }
  }

  const assertions = Array.isArray(feature.assertions) ? feature.assertions : [];
  for (const assertion of assertions) {
    if (!assertion || typeof assertion !== "object") {
      fail(`Feature drift: feature '${id}' has invalid assertion entry`);
      continue;
    }

    const assertionPath = String(assertion.path ?? "").trim();
    const pattern = String(assertion.pattern ?? "").trim();
    if (!assertionPath || !pattern) {
      fail(`Feature drift: feature '${id}' assertion requires path and pattern`);
      continue;
    }

    if (!fileExists(assertionPath)) {
      fail(`Feature drift: assertion file missing for feature '${id}' at '${assertionPath}'`);
      continue;
    }

    const content = readText(assertionPath);
    if (!content.includes(pattern)) {
      fail(
        `Feature drift: assertion failed for feature '${id}' in '${assertionPath}' (missing pattern '${pattern}')`
      );
    } else {
      pass(`Feature '${id}' assertion passed in ${assertionPath}`);
    }
  }
}

for (const requiredFeatureId of contract.requiredFeatureIds ?? []) {
  if (!featureById.has(requiredFeatureId)) {
    fail(`Feature drift: missing required feature '${requiredFeatureId}'`);
  } else {
    pass(`Required feature present: ${requiredFeatureId}`);
  }
}

const featuresReadmePath = "docs/features/README.md";
if (fileExists(featuresReadmePath)) {
  const featuresReadme = readText(featuresReadmePath);
  for (const requiredFeatureId of contract.requiredFeatureIds ?? []) {
    if (!featuresReadme.includes(requiredFeatureId)) {
      fail(`Feature drift: docs/features/README.md is missing feature id '${requiredFeatureId}'`);
    }
  }
  pass("Feature README includes required feature ids");
}

for (const reference of contract.requiredReferences ?? []) {
  if (!reference || typeof reference !== "object") {
    fail("Feature drift: requiredReferences entries must be objects");
    continue;
  }

  const referencePath = String(reference.path ?? "").trim();
  const referencePattern = String(reference.pattern ?? "").trim();

  if (!referencePath || !referencePattern) {
    fail("Feature drift: requiredReferences entries require path and pattern");
    continue;
  }

  if (!fileExists(referencePath)) {
    fail(`Feature drift: required reference path missing '${referencePath}'`);
    continue;
  }

  const referenceContent = readText(referencePath);
  if (!referenceContent.includes(referencePattern)) {
    fail(
      `Feature drift: required reference '${referencePattern}' missing from '${referencePath}'`
    );
  } else {
    pass(`Required reference found in ${referencePath}: ${referencePattern}`);
  }
}

if (features.length === 0) {
  warn("Feature catalog currently has zero features");
}

console.log("");
console.log("Feature Drift Check Summary");
console.log(`- Failures: ${failures.length}`);
console.log(`- Warnings: ${warnings.length}`);

if (warnings.length > 0) {
  console.log("");
  console.log("Warnings:");
  for (const message of warnings) {
    console.log(`- ${message}`);
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
console.log("Feature catalog is in sync with implementation evidence.");
