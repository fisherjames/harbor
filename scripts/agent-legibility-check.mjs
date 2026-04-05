#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function toPosix(value) {
  return value.split(path.sep).join("/");
}

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

function walkMarkdown(relativeDir) {
  const results = [];
  const absoluteDir = resolve(relativeDir);

  if (!fs.existsSync(absoluteDir)) {
    return results;
  }

  const stack = [absoluteDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absoluteEntry = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absoluteEntry);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(toPosix(path.relative(root, absoluteEntry)));
      }
    }
  }

  return results;
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

const contractPath = "docs/strategy/agent-legibility-contract.json";
if (!fileExists(contractPath)) {
  console.error(`FAIL Missing ${contractPath}`);
  process.exit(1);
}

const contract = readJson(contractPath);

for (const requiredPath of contract.requiredEntrypoints ?? []) {
  if (!fileExists(requiredPath)) {
    fail(`Legibility drift: missing required entrypoint '${requiredPath}'`);
  } else {
    pass(`Required entrypoint exists: ${requiredPath}`);
  }
}

for (const requiredDir of contract.requiredDirectories ?? []) {
  const absoluteDir = resolve(requiredDir);
  if (!fs.existsSync(absoluteDir) || !fs.statSync(absoluteDir).isDirectory()) {
    fail(`Legibility drift: missing required directory '${requiredDir}'`);
  } else {
    pass(`Required directory exists: ${requiredDir}`);
  }
}

const agentsPath = "AGENTS.md";
if (!fileExists(agentsPath)) {
  fail("Legibility drift: AGENTS.md is missing");
} else {
  const agentsText = readText(agentsPath);
  const lines = agentsText.split(/\r?\n/).length;
  const maxLines = contract.agents?.maxLines ?? 160;

  if (lines > maxLines) {
    fail(`Legibility drift: AGENTS.md has ${lines} lines, above maxLines=${maxLines}`);
  } else {
    pass(`AGENTS.md line count (${lines}) within limit ${maxLines}`);
  }

  for (const pointer of contract.agents?.requiredPointers ?? []) {
    if (!agentsText.includes(pointer)) {
      fail(`Legibility drift: AGENTS.md missing pointer '${pointer}'`);
    } else {
      pass(`AGENTS.md includes pointer: ${pointer}`);
    }
  }
}

const docsIndexPath = "docs/README.md";
if (!fileExists(docsIndexPath)) {
  fail("Legibility drift: docs/README.md is missing");
} else {
  const docsIndex = readText(docsIndexPath);
  for (const heading of contract.docsIndex?.requiredHeadings ?? []) {
    if (!docsIndex.includes(heading)) {
      fail(`Legibility drift: docs/README.md missing heading '${heading}'`);
    } else {
      pass(`Docs index includes heading: ${heading}`);
    }
  }
}

const repositoryMapConfig = contract.repositoryMap ?? {};
const repositoryMapPath = repositoryMapConfig.path;
if (typeof repositoryMapPath === "string") {
  if (!fileExists(repositoryMapPath)) {
    fail(`Legibility drift: repository map '${repositoryMapPath}' is missing`);
  } else {
    pass(`Repository map exists: ${repositoryMapPath}`);

    let repositoryMap;
    try {
      repositoryMap = readJson(repositoryMapPath);
    } catch {
      fail(`Legibility drift: repository map '${repositoryMapPath}' is not valid JSON`);
    }

    if (repositoryMap) {
      for (const key of repositoryMapConfig.requiredTopLevelKeys ?? []) {
        if (!(key in repositoryMap)) {
          fail(`Legibility drift: repository map missing top-level key '${key}'`);
        } else {
          pass(`Repository map includes key: ${key}`);
        }
      }

      const mappedEntrypoints = new Set(
        Array.isArray(repositoryMap.entrypoints) ? repositoryMap.entrypoints.map((value) => String(value)) : []
      );
      for (const requiredEntrypoint of contract.requiredEntrypoints ?? []) {
        if (!mappedEntrypoints.has(requiredEntrypoint)) {
          fail(`Legibility drift: repository map is missing required entrypoint '${requiredEntrypoint}'`);
        }
      }

      for (const mappedEntrypoint of mappedEntrypoints) {
        if (!fileExists(mappedEntrypoint)) {
          fail(`Legibility drift: repository map references missing entrypoint '${mappedEntrypoint}'`);
        }
      }
      pass("Repository map entrypoints validated");

      const workspaceEntries = Array.isArray(repositoryMap.workspaces) ? repositoryMap.workspaces : [];
      const mapByWorkspacePath = new Map();
      for (const entry of workspaceEntries) {
        if (!entry || typeof entry !== "object") {
          fail("Legibility drift: repository map workspace entry must be an object");
          continue;
        }

        const workspacePath = String(entry.path ?? "");
        const readmePath = String(entry.readme ?? "");
        if (!workspacePath || !readmePath) {
          fail("Legibility drift: repository map workspace entry requires path and readme");
          continue;
        }

        mapByWorkspacePath.set(workspacePath, entry);

        if (!fileExists(workspacePath)) {
          fail(`Legibility drift: repository map workspace path missing '${workspacePath}'`);
        }

        if (!fileExists(readmePath)) {
          fail(`Legibility drift: repository map workspace README missing '${readmePath}'`);
        }

        const workspaceEntrypoints = Array.isArray(entry.entrypoints) ? entry.entrypoints : [];
        if (workspaceEntrypoints.length === 0) {
          fail(`Legibility drift: workspace '${workspacePath}' must declare at least one entrypoint`);
          continue;
        }

        for (const entrypoint of workspaceEntrypoints) {
          const entrypointPath = String(entrypoint);
          if (!fileExists(entrypointPath)) {
            fail(`Legibility drift: workspace '${workspacePath}' references missing entrypoint '${entrypointPath}'`);
          }
        }
      }

      for (const requiredWorkspacePath of repositoryMapConfig.requiredWorkspacePaths ?? []) {
        if (!mapByWorkspacePath.has(requiredWorkspacePath)) {
          fail(`Legibility drift: repository map missing required workspace '${requiredWorkspacePath}'`);
        } else {
          pass(`Repository map includes workspace: ${requiredWorkspacePath}`);
        }
      }

      for (const readmePath of contract.workspaceReadmes?.required ?? []) {
        const mapped = workspaceEntries.some((entry) => entry && typeof entry === "object" && entry.readme === readmePath);
        if (!mapped) {
          fail(`Legibility drift: repository map does not reference required workspace README '${readmePath}'`);
        }
      }
      pass("Repository map workspace coverage validated");
    }
  }
}

const rootReadmePath = "README.md";
if (!fileExists(rootReadmePath)) {
  fail("Legibility drift: README.md is missing");
} else {
  const readme = readText(rootReadmePath);
  if (!readme.includes("## Repository Knowledge Map")) {
    fail("Legibility drift: README.md missing '## Repository Knowledge Map'");
  } else {
    pass("README.md includes repository knowledge map heading");
  }
}

for (const readmePath of contract.workspaceReadmes?.required ?? []) {
  if (!fileExists(readmePath)) {
    fail(`Legibility drift: missing workspace README '${readmePath}'`);
    continue;
  }

  pass(`Workspace README exists: ${readmePath}`);
  const content = readText(readmePath);
  for (const heading of contract.workspaceReadmes?.requiredSections ?? []) {
    if (!content.includes(heading)) {
      fail(`Legibility drift: '${readmePath}' missing heading '${heading}'`);
    } else {
      pass(`Workspace README heading present in ${readmePath}: ${heading}`);
    }
  }
}

const allowedUppercase = new Set(contract.naming?.docsAllowedUppercase ?? []);
for (const markdownPath of walkMarkdown("docs")) {
  const fileName = path.basename(markdownPath);
  if (allowedUppercase.has(fileName)) {
    continue;
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(fileName)) {
    fail(`Legibility drift: docs file '${markdownPath}' is not kebab-case`);
  }
}
pass("Docs naming convention check completed");

for (const scope of ["apps", "packages"]) {
  const absoluteScope = resolve(scope);
  if (!fs.existsSync(absoluteScope)) {
    warn(`Workspace scope '${scope}' is missing`);
    continue;
  }

  for (const entry of fs.readdirSync(absoluteScope, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const folder = entry.name;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder)) {
      fail(`Legibility drift: workspace folder '${scope}/${folder}' must be kebab-case`);
    }

    const packageJsonPath = `${scope}/${folder}/package.json`;
    if (!fileExists(packageJsonPath)) {
      continue;
    }

    const packageJson = readJson(packageJsonPath);
    const expectedName = `@harbor/${folder}`;
    if (packageJson.name !== expectedName) {
      fail(
        `Legibility drift: package name mismatch for '${scope}/${folder}'. Expected '${expectedName}', got '${packageJson.name ?? ""}'`
      );
    } else {
      pass(`Workspace package name aligned: ${packageJson.name}`);
    }
  }
}

console.log("");
console.log("Agent Legibility Check Summary");
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
console.log("Agent legibility contract is in sync with repository structure.");
