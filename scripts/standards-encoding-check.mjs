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

function readText(relativePath) {
  return fs.readFileSync(resolve(relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function lineCount(text) {
  return text.split(/\r?\n/).length;
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

const contractPath = "docs/strategy/team-standards-contract.json";
if (!fileExists(contractPath)) {
  console.error(`FAIL Missing ${contractPath}`);
  process.exit(1);
}

const contract = readJson(contractPath);

for (const requiredPath of contract.requiredFiles ?? []) {
  if (!fileExists(requiredPath)) {
    fail(`Standards drift: missing required file '${requiredPath}'`);
  } else {
    pass(`Required standards file exists: ${requiredPath}`);
  }
}

for (const pattern of contract.forbiddenPatterns ?? []) {
  const matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  for (const targetPath of contract.requiredFiles ?? []) {
    if (!fileExists(targetPath)) {
      continue;
    }

    const text = readText(targetPath);
    if (matcher.test(text)) {
      fail(`Standards drift: forbidden pattern '${pattern}' found in '${targetPath}'`);
    }
  }
}

const template = contract.instructionTemplate ?? {};
for (const instructionPath of template.files ?? []) {
  if (!fileExists(instructionPath)) {
    continue;
  }

  const text = readText(instructionPath);
  const lines = lineCount(text);
  const maxLines = template.maxLines ?? 180;

  if (lines > maxLines) {
    fail(`Standards drift: '${instructionPath}' has ${lines} lines (max ${maxLines})`);
  } else {
    pass(`Instruction length within limit for ${instructionPath}`);
  }

  for (const heading of template.requiredHeadings ?? []) {
    if (!text.includes(heading)) {
      fail(`Standards drift: '${instructionPath}' missing heading '${heading}'`);
    } else {
      pass(`Instruction includes heading '${heading}' in ${instructionPath}`);
    }
  }

  for (const subheading of template.requiredSubheadings ?? []) {
    const regex = new RegExp(`^${subheading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m");
    if (!regex.test(text)) {
      fail(`Standards drift: '${instructionPath}' missing subheading prefix '${subheading}'`);
    } else {
      pass(`Instruction includes subheading prefix '${subheading}' in ${instructionPath}`);
    }
  }

  for (const phrase of template.requiredPhrases ?? []) {
    if (!text.toLowerCase().includes(String(phrase).toLowerCase())) {
      fail(`Standards drift: '${instructionPath}' missing phrase '${phrase}'`);
    } else {
      pass(`Instruction includes phrase '${phrase}' in ${instructionPath}`);
    }
  }
}

const readmeConfig = contract.readme ?? {};
const standardsReadmePath = "docs/team-standards/README.md";
if (fileExists(standardsReadmePath)) {
  const standardsReadme = readText(standardsReadmePath);

  for (const heading of readmeConfig.requiredHeadings ?? []) {
    if (!standardsReadme.includes(heading)) {
      fail(`Standards drift: '${standardsReadmePath}' missing heading '${heading}'`);
    } else {
      pass(`Standards README includes heading '${heading}'`);
    }
  }

  for (const mention of readmeConfig.requiredMentions ?? []) {
    if (!standardsReadme.includes(mention)) {
      fail(`Standards drift: '${standardsReadmePath}' missing mention '${mention}'`);
    } else {
      pass(`Standards README includes mention '${mention}'`);
    }
  }
}

const calibrationConfig = contract.calibration ?? {};
const calibrationPath = calibrationConfig.file;
if (typeof calibrationPath === "string" && fileExists(calibrationPath)) {
  const calibrationText = readText(calibrationPath);

  for (const heading of calibrationConfig.requiredHeadings ?? []) {
    if (!calibrationText.includes(heading)) {
      fail(`Standards drift: '${calibrationPath}' missing heading '${heading}'`);
    } else {
      pass(`Calibration file includes heading '${heading}'`);
    }
  }

  const historyPattern = calibrationConfig.historyEntryPattern;
  if (typeof historyPattern === "string" && historyPattern.length > 0) {
    const regex = new RegExp(historyPattern, "g");
    const matches = calibrationText.match(regex) ?? [];
    const minimum = Number(calibrationConfig.historyMinimumEntries ?? 1);

    if (matches.length < minimum) {
      fail(
        `Standards drift: '${calibrationPath}' has ${matches.length} history entries matching ${historyPattern}, requires ${minimum}`
      );
    } else {
      pass(`Calibration history includes ${matches.length} dated entries`);
    }
  }
}

const harCoverageConfig = contract.harRuleCoverage ?? {};
const matrixPath = harCoverageConfig.matrixFile;
if (typeof matrixPath === "string" && matrixPath.length > 0) {
  if (!fileExists(matrixPath)) {
    fail(`Standards drift: HAR coverage matrix '${matrixPath}' is missing`);
  } else {
    pass(`HAR coverage matrix exists: ${matrixPath}`);

    const matrix = readJson(matrixPath);
    const entries = Array.isArray(matrix.rules) ? matrix.rules : [];
    const requiredEntryKeys = new Set(harCoverageConfig.requiredEntryKeys ?? []);

    const visionContractPath = harCoverageConfig.visionContractFile;
    let requiredRules = new Set();
    if (typeof visionContractPath === "string" && fileExists(visionContractPath)) {
      const visionContract = readJson(visionContractPath);
      requiredRules = new Set(visionContract.requiredHarnessRules ?? []);
      pass(`Loaded required harness rules from ${visionContractPath}`);
    } else {
      fail("Standards drift: unable to load required harness rules for HAR coverage matrix validation");
    }

    const entryByRule = new Map();
    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object") {
        fail(`Standards drift: HAR matrix entry at index ${index} is not an object`);
        continue;
      }

      for (const key of requiredEntryKeys) {
        if (!(key in entry)) {
          fail(`Standards drift: HAR matrix entry at index ${index} is missing '${key}'`);
        }
      }

      const ruleId = String(entry.ruleId ?? "");
      if (!ruleId) {
        fail(`Standards drift: HAR matrix entry at index ${index} has empty ruleId`);
        continue;
      }

      if (entryByRule.has(ruleId)) {
        fail(`Standards drift: HAR matrix contains duplicate rule entry '${ruleId}'`);
      } else {
        entryByRule.set(ruleId, entry);
      }

      if (requiredRules.size > 0 && !requiredRules.has(ruleId)) {
        fail(`Standards drift: HAR matrix has rule '${ruleId}' not present in vision-contract requiredHarnessRules`);
      }

      const standardFiles = Array.isArray(entry.standardFiles) ? entry.standardFiles : [];
      if (standardFiles.length === 0) {
        fail(`Standards drift: HAR matrix rule '${ruleId}' must include at least one standardFiles entry`);
      }

      for (const standardFile of standardFiles) {
        if (!fileExists(standardFile)) {
          fail(`Standards drift: HAR matrix rule '${ruleId}' references missing file '${standardFile}'`);
          continue;
        }

        const standardsText = readText(standardFile);
        if (!standardsText.includes(ruleId)) {
          fail(`Standards drift: HAR matrix rule '${ruleId}' not explicitly mentioned in '${standardFile}'`);
        } else {
          pass(`HAR matrix rule '${ruleId}' is mentioned in ${standardFile}`);
        }
      }
    }

    for (const requiredRule of requiredRules) {
      if (!entryByRule.has(requiredRule)) {
        fail(`Standards drift: HAR matrix missing required rule '${requiredRule}'`);
      } else {
        pass(`HAR matrix includes required rule ${requiredRule}`);
      }
    }

    const linterSourcePath = harCoverageConfig.linterSourceFile;
    if (typeof linterSourcePath === "string" && fileExists(linterSourcePath)) {
      const linterSource = readText(linterSourcePath);
      const linterRuleTargets = new Map();
      const regex = /if \(ruleId === "(HAR\d+)"\) \{[\s\S]*?templateTarget: "([^"]+)"/g;

      for (const match of linterSource.matchAll(regex)) {
        linterRuleTargets.set(match[1], match[2]);
      }

      if (linterRuleTargets.size === 0) {
        warn(`Unable to extract HAR templateTarget mappings from ${linterSourcePath}`);
      } else {
        pass(`Extracted HAR templateTarget mappings from ${linterSourcePath}`);
      }

      for (const [ruleId, entry] of entryByRule.entries()) {
        const expectedTarget = String(entry.templateTarget ?? "");
        const linterTarget = linterRuleTargets.get(ruleId);
        if (!linterTarget) {
          fail(`Standards drift: linter mapping for '${ruleId}' is missing in ${linterSourcePath}`);
          continue;
        }

        if (expectedTarget !== linterTarget) {
          fail(
            `Standards drift: templateTarget mismatch for '${ruleId}' (matrix='${expectedTarget}', linter='${linterTarget}')`
          );
        } else {
          pass(`HAR matrix target matches linter for ${ruleId} (${expectedTarget})`);
        }
      }
    } else {
      fail("Standards drift: linter source file for HAR coverage mapping is missing");
    }
  }
}

const docsIndexPath = "docs/README.md";
if (fileExists(docsIndexPath)) {
  const docsIndex = readText(docsIndexPath);
  if (!docsIndex.includes("## Team Standards")) {
    fail("Standards drift: docs/README.md missing '## Team Standards' section");
  } else {
    pass("Docs index includes Team Standards section");
  }
}

const agentsPath = "AGENTS.md";
if (fileExists(agentsPath)) {
  const agents = readText(agentsPath);
  if (!agents.includes("docs/team-standards/README.md")) {
    warn("AGENTS.md does not point to docs/team-standards/README.md");
  } else {
    pass("AGENTS.md points to team standards index");
  }
}

console.log("");
console.log("Standards Encoding Check Summary");
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
console.log("Team standards contract is in sync with encoded instructions.");
