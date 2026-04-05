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

function parseIsoDate(input) {
  const value = `${input}T00:00:00.000Z`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
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

    const dateRegex = /(\d{4}-\d{2}-\d{2}):/g;
    const historyDates = [];
    for (const match of calibrationText.matchAll(dateRegex)) {
      const parsed = parseIsoDate(match[1]);
      if (parsed) {
        historyDates.push(parsed);
      }
    }

    if (historyDates.length > 0) {
      historyDates.sort((a, b) => b.getTime() - a.getTime());
      const latest = historyDates[0];
      const ageMs = Date.now() - latest.getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
      const warningAfterDays = Number(calibrationConfig.warningAfterDays ?? 31);
      const failAfterDays = Number(calibrationConfig.failAfterDays ?? 45);

      if (ageDays > failAfterDays) {
        fail(
          `Standards drift: calibration history is stale (${ageDays} days > failAfterDays=${failAfterDays}). Add a new history entry.`
        );
      } else if (ageDays > warningAfterDays) {
        warn(
          `Calibration freshness warning: latest calibration entry is ${ageDays} days old (warningAfterDays=${warningAfterDays}).`
        );
      } else {
        pass(`Calibration freshness within threshold (${ageDays} days old)`);
      }
    } else {
      fail("Standards drift: unable to parse dated calibration history entries");
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

    const catalogSourcePath = harCoverageConfig.catalogSourceFile;
    if (typeof catalogSourcePath === "string" && fileExists(catalogSourcePath)) {
      const catalogSource = readText(catalogSourcePath);
      const catalogRuleTargets = new Map();
      const blockStartToken = "export const HAR_TEMPLATE_TARGET_BY_RULE";
      const blockStart = catalogSource.indexOf(blockStartToken);
      const blockEnd = blockStart === -1 ? -1 : catalogSource.indexOf("};", blockStart);
      const targetBlock =
        blockStart === -1 || blockEnd === -1 ? "" : catalogSource.slice(blockStart, blockEnd + 2);
      const regex = /(HAR\d+):\s*"([^"]+)"/g;

      for (const match of targetBlock.matchAll(regex)) {
        catalogRuleTargets.set(match[1], match[2]);
      }

      if (catalogRuleTargets.size === 0) {
        warn(`Unable to extract HAR templateTarget mappings from ${catalogSourcePath}`);
      } else {
        pass(`Extracted HAR templateTarget mappings from ${catalogSourcePath}`);
      }

      for (const [ruleId, entry] of entryByRule.entries()) {
        const expectedTarget = String(entry.templateTarget ?? "");
        const catalogTarget = catalogRuleTargets.get(ruleId);
        if (!catalogTarget) {
          fail(`Standards drift: harness catalog mapping for '${ruleId}' is missing in ${catalogSourcePath}`);
          continue;
        }

        if (expectedTarget !== catalogTarget) {
          fail(
            `Standards drift: templateTarget mismatch for '${ruleId}' (matrix='${expectedTarget}', catalog='${catalogTarget}')`
          );
        } else {
          pass(`HAR matrix target matches harness catalog for ${ruleId} (${expectedTarget})`);
        }
      }
    } else {
      fail("Standards drift: harness catalog source file for HAR coverage mapping is missing");
    }
  }
}

const harExamplesConfig = contract.harExamples ?? {};
const examplesPath = harExamplesConfig.file;
if (typeof examplesPath === "string" && examplesPath.length > 0) {
  if (!fileExists(examplesPath)) {
    fail(`Standards drift: HAR examples pack '${examplesPath}' is missing`);
  } else {
    pass(`HAR examples pack exists: ${examplesPath}`);
    const examplesPack = readJson(examplesPath);
    const exampleEntries = Array.isArray(examplesPack.rules) ? examplesPack.rules : [];
    const requiredEntryKeys = new Set(harExamplesConfig.requiredEntryKeys ?? []);
    const requiredExampleKeys = new Set(harExamplesConfig.requiredExampleKeys ?? []);
    const allowedKinds = new Set(harExamplesConfig.allowedKinds ?? []);

    const visionRules = fileExists("docs/strategy/vision-contract.json")
      ? new Set(readJson("docs/strategy/vision-contract.json").requiredHarnessRules ?? [])
      : new Set();
    const examplesByRule = new Map();

    for (const [index, entry] of exampleEntries.entries()) {
      if (!entry || typeof entry !== "object") {
        fail(`Standards drift: HAR examples entry at index ${index} is not an object`);
        continue;
      }

      for (const key of requiredEntryKeys) {
        if (!(key in entry)) {
          fail(`Standards drift: HAR examples entry at index ${index} missing '${key}'`);
        }
      }

      const ruleId = String(entry.ruleId ?? "");
      if (!ruleId) {
        fail(`Standards drift: HAR examples entry at index ${index} has empty ruleId`);
        continue;
      }

      if (examplesByRule.has(ruleId)) {
        fail(`Standards drift: HAR examples pack contains duplicate rule '${ruleId}'`);
      } else {
        examplesByRule.set(ruleId, entry);
      }

      if (visionRules.size > 0 && !visionRules.has(ruleId)) {
        fail(`Standards drift: HAR examples rule '${ruleId}' is not in vision requiredHarnessRules`);
      }

      const examples = Array.isArray(entry.examples) ? entry.examples : [];
      if (examples.length === 0) {
        fail(`Standards drift: HAR examples rule '${ruleId}' must include at least one example`);
        continue;
      }

      for (const [exampleIndex, example] of examples.entries()) {
        if (!example || typeof example !== "object") {
          fail(`Standards drift: HAR examples '${ruleId}' entry ${exampleIndex} must be an object`);
          continue;
        }

        for (const key of requiredExampleKeys) {
          if (!(key in example)) {
            fail(`Standards drift: HAR examples '${ruleId}' entry ${exampleIndex} missing '${key}'`);
          }
        }

        const examplePath = String(example.path ?? "");
        const kind = String(example.kind ?? "");
        if (!examplePath || !fileExists(examplePath)) {
          fail(`Standards drift: HAR examples '${ruleId}' references missing path '${examplePath}'`);
          continue;
        }

        if (allowedKinds.size > 0 && !allowedKinds.has(kind)) {
          fail(
            `Standards drift: HAR examples '${ruleId}' has unsupported kind '${kind}'. Allowed: ${[...allowedKinds].join(", ")}`
          );
        }

        const content = readText(examplePath);
        if (!content.includes(ruleId)) {
          fail(`Standards drift: HAR examples path '${examplePath}' does not reference '${ruleId}'`);
        } else {
          pass(`HAR examples '${ruleId}' validated against ${examplePath}`);
        }
      }
    }

    for (const requiredRule of visionRules) {
      if (!examplesByRule.has(requiredRule)) {
        fail(`Standards drift: HAR examples pack missing required rule '${requiredRule}'`);
      } else {
        pass(`HAR examples pack includes required rule ${requiredRule}`);
      }
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
