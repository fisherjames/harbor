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

function hasDependency(packageJsonPath, dependencyName) {
  const pkg = readJson(packageJsonPath);
  const dependencies = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {})
  };
  return Boolean(dependencies[dependencyName]);
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

if (!fileExists("docs/strategy/vision-contract.json")) {
  console.error("FAIL Missing docs/strategy/vision-contract.json");
  process.exit(1);
}

if (!fileExists("docs/strategy/phase-tracker.json")) {
  console.error("FAIL Missing docs/strategy/phase-tracker.json");
  process.exit(1);
}

const visionContract = readJson("docs/strategy/vision-contract.json");
const phaseTracker = readJson("docs/strategy/phase-tracker.json");
const visionDoc = readText("docs/strategy/vision.md");
const normalizedVisionDoc = visionDoc.replace(/[^a-zA-Z0-9\s]/g, " ").toLowerCase();

for (const workspacePath of visionContract.requiredWorkspaces ?? []) {
  if (!fileExists(workspacePath)) {
    fail(`Missing required workspace: ${workspacePath}`);
  } else {
    pass(`Workspace exists: ${workspacePath}`);
  }
}

for (const ruleId of visionContract.requiredHarnessRules ?? []) {
  const coreRules = readText("packages/harness/src/rules/core-rules.ts");
  if (!coreRules.includes(ruleId)) {
    fail(`Harness rule missing: ${ruleId}`);
  } else {
    pass(`Harness rule present: ${ruleId}`);
  }
}

for (const adrPath of visionContract.requiredDecisionRecords ?? []) {
  if (!fileExists(adrPath)) {
    fail(`Missing required ADR: ${adrPath}`);
  } else {
    pass(`ADR exists: ${adrPath}`);
  }
}

if (!hasDependency("apps/worker/package.json", "inngest")) {
  fail("Locked decision drift: Inngest dependency missing from apps/worker");
} else {
  pass("Locked decision upheld: Inngest runtime dependency present");
}

if (!hasDependency("apps/web/package.json", "@clerk/nextjs")) {
  fail("Locked decision drift: Clerk dependency missing from apps/web");
} else {
  pass("Locked decision upheld: Clerk dependency present");
}

if (!hasDependency("packages/api/package.json", "@trpc/server")) {
  fail("Locked decision drift: @trpc/server missing from packages/api");
} else {
  pass("Locked decision upheld: API uses @trpc/server");
}

if (!hasDependency("apps/web/package.json", "@trpc/client")) {
  fail("Locked decision drift: @trpc/client missing from apps/web");
} else {
  pass("Locked decision upheld: Web uses @trpc/client");
}

if (!fileExists("packages/memu/src/index.ts")) {
  fail("Locked decision drift: memU adapter package is missing");
} else {
  pass("Locked decision upheld: memU adapter package present");
}

const apiRouter = readText("packages/api/src/router.ts");
if (!apiRouter.includes("if (!ctx.tenantId || !ctx.workspaceId || !ctx.actorId)")) {
  fail("Tenancy drift: API context guard for tenant/workspace/actor is missing");
} else {
  pass("Tenancy guard present in API router");
}

if (!apiRouter.includes('runLintAtExecutionPoint("deploy", version.workflow)')) {
  fail("Publish drift: deploy lint execution missing before publish");
} else {
  pass("Publish path executes deploy lint");
}

if (!apiRouter.includes("blocked: true")) {
  warn("Publish path may no longer explicitly return blocked response payload");
} else {
  pass("Publish path exposes blocked response payload");
}

if (visionContract.requiredPolicies?.evalGateOnDeploy) {
  if (!apiRouter.includes("resolveDeployGates")) {
    fail("Deploy gate drift: deploy/publish gate resolver is missing from API router");
  } else {
    pass("Deploy/publish gate resolver present in API router");
  }

  if (!apiRouter.includes('event: "deploy"')) {
    fail("Deploy gate drift: deploy path no longer tags gate execution with event=deploy");
  } else {
    pass("Deploy path tags gate execution with event=deploy");
  }

  if (!/eval\s+gate/.test(normalizedVisionDoc)) {
    fail("Vision drift: eval gate requirement missing from vision.md");
  } else {
    pass("Vision includes eval gate requirement");
  }
}

if (visionContract.requiredPolicies?.githubPromotionChecks) {
  if (!apiRouter.includes("runPromotionChecks")) {
    fail("Promotion drift: GitHub promotion check hook is missing from API router");
  } else {
    pass("API router includes promotion check hook");
  }

  if (!apiRouter.includes('provider: "github"')) {
    fail("Promotion drift: API router no longer defaults promotion checks to provider=github");
  } else {
    pass("API router keeps GitHub promotion provider default");
  }

  if (!/(github.*promotion|promotion.*github)/.test(normalizedVisionDoc)) {
    fail("Vision drift: GitHub promotion requirement missing from vision.md");
  } else {
    pass("Vision includes GitHub promotion requirement");
  }
}

const engineRunner = readText("packages/engine/src/runtime/runner.ts");
if (!engineRunner.includes("harness-resolution-steps")) {
  fail("Harness drift: runtime no longer persists harness resolution artifacts");
} else {
  pass("Runtime persists harness resolution artifacts");
}

const agentsContract = readText("AGENTS.md");
const normalizedAgentsContract = agentsContract.replace(/[^a-zA-Z0-9\s]/g, " ").toLowerCase();
if (!/not\s+(a\s+)?brian\s+workspace/.test(normalizedAgentsContract)) {
  fail("Project-scope drift: AGENTS.md no longer asserts non-Brian workspace");
} else {
  pass("AGENTS.md confirms non-Brian workspace");
}

if (!agentsContract.includes("Use only repository-local rules and skills")) {
  fail("Project-scope drift: AGENTS.md no longer enforces repo-local rules/skills");
} else {
  pass("AGENTS.md enforces repo-local rules/skills");
}

if (visionContract.requiredPolicies?.worktreeBoundRuns) {
  if (!/worktree\s+bound/.test(normalizedVisionDoc)) {
    fail("Vision drift: worktree-bound run policy missing from vision.md");
  } else {
    pass("Vision includes worktree-bound run policy");
  }

  if (!/worktree\s+bound/.test(normalizedAgentsContract)) {
    fail("Project policy drift: AGENTS.md missing worktree-bound run invariant");
  } else {
    pass("AGENTS.md includes worktree-bound run invariant");
  }
}

if (visionContract.requiredPolicies?.runCanBuildWholeStack) {
  if (!/full\s+stack/.test(normalizedVisionDoc)) {
    fail("Vision drift: full-stack run isolation policy missing from vision.md");
  } else {
    pass("Vision includes full-stack run isolation policy");
  }
}

if (visionContract.requiredPolicies?.ephemeralObservabilityPerRun) {
  if (!/ephemeral\s+observability/.test(normalizedVisionDoc)) {
    fail("Vision drift: ephemeral observability policy missing from vision.md");
  } else {
    pass("Vision includes ephemeral observability policy");
  }

  if (!/ephemeral\s+observability/.test(normalizedAgentsContract)) {
    fail("Project policy drift: AGENTS.md missing ephemeral observability invariant");
  } else {
    pass("AGENTS.md includes ephemeral observability invariant");
  }
}

const validPhaseStatuses = new Set(["planned", "in_progress", "complete"]);
const trackedPhases = phaseTracker.phases ?? [];
const currentPhase = phaseTracker.currentPhase;

if (!trackedPhases.some((phase) => phase.id === currentPhase)) {
  fail(`Phase tracker drift: currentPhase '${currentPhase}' is not defined in phases[]`);
}

for (const phase of trackedPhases) {
  if (!validPhaseStatuses.has(phase.status)) {
    fail(`Phase tracker drift: invalid status '${phase.status}' for ${phase.id}`);
  }

  for (const evidencePath of phase.evidence ?? []) {
    if (!fileExists(evidencePath)) {
      fail(`Phase tracker drift: missing evidence path '${evidencePath}' for ${phase.id}`);
    }
  }
}

console.log("");
console.log("Vision Drift Check Summary");
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
console.log("Vision contract is in sync with current implementation.");
