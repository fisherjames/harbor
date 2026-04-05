#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function readJson(relativePath) {
  const fullPath = path.join(root, relativePath);
  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
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

const requiredFiles = [
  "docs/strategy/documentation-contract.json",
  "docs/strategy/phase-tracker.json",
  "docs/strategy/vision-contract.json"
];

for (const relativePath of requiredFiles) {
  if (!fileExists(relativePath)) {
    console.error(`FAIL Missing ${relativePath}`);
    process.exit(1);
  }
}

const docsContract = readJson("docs/strategy/documentation-contract.json");
const phaseTracker = readJson("docs/strategy/phase-tracker.json");
const visionContract = readJson("docs/strategy/vision-contract.json");

for (const relativePath of docsContract.requiredDocuments ?? []) {
  if (!fileExists(relativePath)) {
    fail(`Documentation drift: missing required document '${relativePath}'`);
  } else {
    pass(`Required document exists: ${relativePath}`);
  }
}

const gettingStartedPath = "docs/getting-started.md";
if (!fileExists(gettingStartedPath)) {
  fail("Documentation drift: docs/getting-started.md is missing");
} else {
  const gettingStarted = readText(gettingStartedPath);
  const normalized = gettingStarted.toLowerCase();

  for (const heading of docsContract.gettingStarted?.requiredHeadings ?? []) {
    if (!gettingStarted.includes(heading)) {
      fail(`Documentation drift: missing heading '${heading}' in docs/getting-started.md`);
    } else {
      pass(`Getting Started includes heading: ${heading}`);
    }
  }

  for (const command of docsContract.gettingStarted?.requiredCommands ?? []) {
    if (!gettingStarted.includes(command)) {
      fail(`Documentation drift: missing command '${command}' in docs/getting-started.md`);
    } else {
      pass(`Getting Started includes command: ${command}`);
    }
  }

  for (const phrase of docsContract.gettingStarted?.requiredPhrases ?? []) {
    if (!normalized.includes(phrase.toLowerCase())) {
      fail(`Documentation drift: missing phrase '${phrase}' in docs/getting-started.md`);
    } else {
      pass(`Getting Started includes phrase: ${phrase}`);
    }
  }

  const metadataStart = docsContract.gettingStarted?.metadataStart;
  const metadataEnd = docsContract.gettingStarted?.metadataEnd;

  if (!metadataStart || !metadataEnd) {
    fail("Documentation drift: metadata markers are not configured in documentation-contract.json");
  } else {
    const startIndex = gettingStarted.indexOf(metadataStart);
    const endIndex = gettingStarted.indexOf(metadataEnd);

    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
      fail("Documentation drift: DOCS_CADENCE_METADATA block is missing or malformed");
    } else {
      const rawMetadata = gettingStarted.slice(startIndex + metadataStart.length, endIndex).trim();
      let metadata;

      try {
        metadata = JSON.parse(rawMetadata);
      } catch {
        fail("Documentation drift: DOCS_CADENCE_METADATA is not valid JSON");
      }

      if (metadata) {
        if (metadata.currentPhase !== phaseTracker.currentPhase) {
          fail(
            `Documentation cadence drift: currentPhase '${metadata.currentPhase}' does not match phase-tracker '${phaseTracker.currentPhase}'`
          );
        } else {
          pass(`Documentation current phase matches phase tracker: ${phaseTracker.currentPhase}`);
        }

        const documentedRules = [...(metadata.harnessRules ?? [])].sort();
        const requiredRules = [...(visionContract.requiredHarnessRules ?? [])].sort();
        if (JSON.stringify(documentedRules) !== JSON.stringify(requiredRules)) {
          fail("Documentation cadence drift: Getting Started harnessRules do not match vision-contract requiredHarnessRules");
        } else {
          pass("Getting Started harness rules match vision contract");
        }

        const documentedMilestones = new Map((metadata.milestones ?? []).map((entry) => [entry.id, entry]));
        const knownPhaseIds = new Set((phaseTracker.phases ?? []).map((phase) => phase.id));

        for (const phase of phaseTracker.phases ?? []) {
          const documented = documentedMilestones.get(phase.id);
          if (!documented) {
            fail(`Documentation cadence drift: phase '${phase.id}' missing from DOCS_CADENCE_METADATA`);
            continue;
          }

          if (documented.status !== phase.status) {
            fail(
              `Documentation cadence drift: phase '${phase.id}' status '${documented.status}' does not match phase-tracker '${phase.status}'`
            );
          } else {
            pass(`Phase metadata aligned for ${phase.id}`);
          }

          if ((phase.status === "in_progress" || phase.status === "complete") && documented.docsVerified !== true) {
            fail(`Documentation cadence drift: phase '${phase.id}' must set docsVerified=true while status is '${phase.status}'`);
          }
        }

        for (const documentedPhase of metadata.milestones ?? []) {
          if (!knownPhaseIds.has(documentedPhase.id)) {
            warn(`Documentation metadata has unknown phase '${documentedPhase.id}'`);
          }
        }
      }
    }
  }
}

console.log("");
console.log("Docs Drift Check Summary");
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
console.log("Documentation contract is in sync with phase and harness metadata.");
