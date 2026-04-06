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

function hasScript(packageJsonPath, scriptName) {
  const pkg = readJson(packageJsonPath);
  return Boolean(pkg.scripts?.[scriptName]);
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

const workerInngest = readText("apps/worker/src/inngest.ts");

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

if (visionContract.requiredPolicies?.shadowRegressionGate) {
  if (!apiRouter.includes("runShadowGate")) {
    fail("Shadow gate drift: shadow gate hook is missing from API router");
  } else {
    pass("API router includes shadow gate hook");
  }

  if (!apiRouter.includes('"shadow"')) {
    fail("Shadow gate drift: shadow blocked reason is missing from API router contracts");
  } else {
    pass("API router includes shadow blocked reason handling");
  }

  if (!/shadow/.test(normalizedVisionDoc)) {
    fail("Vision drift: shadow regression requirement missing from vision.md");
  } else {
    pass("Vision includes shadow regression requirement");
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

if (visionContract.requiredPolicies?.agentLegibilityGate) {
  if (!fileExists("scripts/agent-legibility-check.mjs")) {
    fail("Legibility drift: scripts/agent-legibility-check.mjs is missing");
  } else {
    pass("Legibility drift check script exists");
  }

  if (!hasScript("package.json", "legibility:check")) {
    fail("Legibility drift: package.json missing legibility:check script");
  } else {
    pass("Root package exposes legibility:check script");
  }

  const rootPkg = readJson("package.json");
  const rootCheck = String(rootPkg.scripts?.check ?? "");
  if (!rootCheck.includes("pnpm legibility:check")) {
    fail("Legibility drift: root check script does not include pnpm legibility:check");
  } else {
    pass("Root check script includes legibility gate");
  }

  if (!fileExists("docs/README.md")) {
    fail("Legibility drift: docs/README.md is missing");
  } else {
    const docsIndex = readText("docs/README.md");
    if (!docsIndex.includes("# Harbor Docs Index")) {
      fail("Legibility drift: docs/README.md missing docs index heading");
    } else {
      pass("Docs index heading present");
    }
  }

  if (!agentsContract.includes("docs/README.md")) {
    fail("Legibility drift: AGENTS.md missing docs index pointer");
  } else {
    pass("AGENTS.md includes docs index pointer");
  }

  if (!/legibility/.test(normalizedVisionDoc)) {
    fail("Vision drift: repository legibility policy missing from vision.md");
  } else {
    pass("Vision includes repository legibility policy");
  }
}

if (visionContract.requiredPolicies?.teamStandardsEncodingGate) {
  if (!fileExists("scripts/standards-encoding-check.mjs")) {
    fail("Standards drift: scripts/standards-encoding-check.mjs is missing");
  } else {
    pass("Standards drift check script exists");
  }

  if (!hasScript("package.json", "standards:check")) {
    fail("Standards drift: package.json missing standards:check script");
  } else {
    pass("Root package exposes standards:check script");
  }

  const rootPkg = readJson("package.json");
  const rootCheck = String(rootPkg.scripts?.check ?? "");
  if (!rootCheck.includes("pnpm standards:check")) {
    fail("Standards drift: root check script does not include pnpm standards:check");
  } else {
    pass("Root check script includes standards gate");
  }

  if (!fileExists("docs/strategy/team-standards-contract.json")) {
    fail("Standards drift: docs/strategy/team-standards-contract.json is missing");
  } else {
    pass("Team standards contract exists");
  }

  if (!fileExists("docs/team-standards/README.md")) {
    fail("Standards drift: docs/team-standards/README.md is missing");
  } else {
    pass("Team standards README exists");
  }

  if (!/team\s+standards/.test(normalizedVisionDoc)) {
    fail("Vision drift: team standards encoding policy missing from vision.md");
  } else {
    pass("Vision includes team standards encoding policy");
  }
}

if (visionContract.requiredPolicies?.evaluatorCalibrationGate) {
  if (!fileExists("scripts/evaluator-calibration-check.mjs")) {
    fail("Evaluator drift: scripts/evaluator-calibration-check.mjs is missing");
  } else {
    pass("Evaluator drift check script exists");
  }

  if (!hasScript("package.json", "evaluator:check")) {
    fail("Evaluator drift: package.json missing evaluator:check script");
  } else {
    pass("Root package exposes evaluator:check script");
  }

  const rootPkg = readJson("package.json");
  const rootCheck = String(rootPkg.scripts?.check ?? "");
  if (!rootCheck.includes("pnpm evaluator:check")) {
    fail("Evaluator drift: root check script does not include pnpm evaluator:check");
  } else {
    pass("Root check script includes evaluator calibration gate");
  }

  if (!fileExists("docs/strategy/evaluator-calibration-contract.json")) {
    fail("Evaluator drift: docs/strategy/evaluator-calibration-contract.json is missing");
  } else {
    pass("Evaluator calibration contract exists");
  }

  if (!apiRouter.includes("calibration:")) {
    fail("Evaluator drift: eval gate response no longer includes calibration metadata");
  } else {
    pass("API router includes eval calibration metadata");
  }

  if (!/evaluator/.test(normalizedVisionDoc)) {
    fail("Vision drift: evaluator calibration requirement missing from vision.md");
  } else {
    pass("Vision includes evaluator calibration requirement");
  }
}

if (visionContract.requiredPolicies?.adversarialNightlyTaxonomyGate) {
  if (!fileExists("scripts/adversarial-taxonomy-check.mjs")) {
    fail("Adversarial drift: scripts/adversarial-taxonomy-check.mjs is missing");
  } else {
    pass("Adversarial taxonomy check script exists");
  }

  if (!hasScript("package.json", "adversarial:check")) {
    fail("Adversarial drift: package.json missing adversarial:check script");
  } else {
    pass("Root package exposes adversarial:check script");
  }

  const rootPkg = readJson("package.json");
  const rootCheck = String(rootPkg.scripts?.check ?? "");
  if (!rootCheck.includes("pnpm adversarial:check")) {
    fail("Adversarial drift: root check script does not include pnpm adversarial:check");
  } else {
    pass("Root check script includes adversarial taxonomy gate");
  }

  if (!workerInngest.includes("adversarialNightlyScheduled")) {
    fail("Adversarial drift: worker nightly scheduled function is missing");
  } else {
    pass("Worker includes adversarial nightly scheduled function");
  }

  if (!workerInngest.includes('cron: "0 3 * * *"')) {
    fail("Adversarial drift: worker nightly schedule cron is missing");
  } else {
    pass("Worker nightly schedule cron is configured");
  }

  if (!apiRouter.includes("taxonomy:")) {
    fail("Adversarial drift: API adversarial gate no longer includes taxonomy metadata");
  } else {
    pass("API adversarial gate includes taxonomy metadata");
  }

  if (!/adversarial/.test(normalizedVisionDoc) || !/taxonomy/.test(normalizedVisionDoc)) {
    fail("Vision drift: adversarial nightly taxonomy requirement missing from vision.md");
  } else {
    pass("Vision includes adversarial nightly taxonomy requirement");
  }
}

if (visionContract.requiredPolicies?.featureCatalogGate) {
  if (!fileExists("scripts/features-drift-check.mjs")) {
    fail("Feature drift: scripts/features-drift-check.mjs is missing");
  } else {
    pass("Feature drift check script exists");
  }

  if (!hasScript("package.json", "features:check")) {
    fail("Feature drift: package.json missing features:check script");
  } else {
    pass("Root package exposes features:check script");
  }

  const rootPkg = readJson("package.json");
  const rootCheck = String(rootPkg.scripts?.check ?? "");
  if (!rootCheck.includes("pnpm features:check")) {
    fail("Feature drift: root check script does not include pnpm features:check");
  } else {
    pass("Root check script includes feature catalog gate");
  }

  if (!fileExists("docs/strategy/features-contract.json")) {
    fail("Feature drift: docs/strategy/features-contract.json is missing");
  } else {
    pass("Feature contract exists");
  }

  if (!fileExists("docs/features/README.md")) {
    fail("Feature drift: docs/features/README.md is missing");
  } else {
    pass("Feature README exists");
  }

  if (!/feature\s+catalog/.test(normalizedVisionDoc)) {
    fail("Vision drift: feature catalog requirement missing from vision.md");
  } else {
    pass("Vision includes feature catalog requirement");
  }
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

const activePlansReadmePath = "docs/exec-plans/active/README.md";
if (!fileExists(activePlansReadmePath)) {
  fail("Execution plan drift: docs/exec-plans/active/README.md is missing");
} else {
  const activePlansReadme = readText(activePlansReadmePath);
  const activePlanMatches = [...activePlansReadme.matchAll(/docs\/exec-plans\/active\/[a-zA-Z0-9._-]+\.md/g)];
  const activePlanRelativePath = activePlanMatches[0]?.[0];

  if (!activePlanRelativePath) {
    fail("Execution plan drift: active plan README does not reference a current active plan file");
  } else {
    if (!fileExists(activePlanRelativePath)) {
      fail(`Execution plan drift: active plan file is missing at '${activePlanRelativePath}'`);
    } else {
      pass(`Active execution plan file exists: ${activePlanRelativePath}`);
    }

    if (!activePlanRelativePath.includes(currentPhase)) {
      fail(
        `Execution plan drift: active plan '${activePlanRelativePath}' does not align with currentPhase '${currentPhase}'`
      );
    } else {
      pass(`Active execution plan aligns with currentPhase: ${currentPhase}`);
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
