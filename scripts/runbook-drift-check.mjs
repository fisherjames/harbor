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

function writeText(relativePath, content) {
  const fullPath = resolve(relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function uniquePreserveOrder(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }
  return output;
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

const requiredInputs = [
  "docs/strategy/phase-tracker.json",
  "docs/features/harness-features.json",
  "docs/evaluator/reports/latest.json",
  "docs/adversarial/reports/latest.json",
  "docs/inference/reports/latest.json",
  "docs/team-standards/reports/latest.json"
];

for (const required of requiredInputs) {
  if (!fileExists(required)) {
    fail(`Runbook drift: missing required input '${required}'`);
  } else {
    pass(`Runbook input exists: ${required}`);
  }
}

if (failures.length > 0) {
  console.log("");
  console.log("Runbook Drift Check Summary");
  console.log(`- Failures: ${failures.length}`);
  console.log(`- Warnings: ${warnings.length}`);
  console.log("");
  console.log("Failures:");
  for (const message of failures) {
    console.log(`- ${message}`);
  }
  process.exit(1);
}

const phaseTracker = readJson("docs/strategy/phase-tracker.json");
const featureCatalog = readJson("docs/features/harness-features.json");
const evaluatorReport = readJson("docs/evaluator/reports/latest.json");
const adversarialReport = readJson("docs/adversarial/reports/latest.json");
const inferenceReport = readJson("docs/inference/reports/latest.json");
const standardsReport = readJson("docs/team-standards/reports/latest.json");

const phase3 = Array.isArray(phaseTracker.phases)
  ? phaseTracker.phases.find((phase) => phase?.id === "phase-3")
  : null;
if (!phase3 || typeof phase3 !== "object") {
  fail("Runbook drift: phase-3 entry missing from docs/strategy/phase-tracker.json");
}

const features = Array.isArray(featureCatalog.features) ? featureCatalog.features : [];
const phase3Features = features.filter((feature) => feature?.phase === "phase-3");
const completePhase3Features = phase3Features.filter((feature) => feature?.status === "complete");
const inProgressPhase3Features = phase3Features.filter((feature) => feature?.status === "in_progress");
const plannedPhase3Features = phase3Features.filter((feature) => feature?.status === "planned");

if (phase3Features.length === 0) {
  fail("Runbook drift: feature catalog has no phase-3 feature entries.");
} else {
  pass(`Runbook found ${phase3Features.length} phase-3 feature entries.`);
}

const evaluatorStatus = String(evaluatorReport.status ?? "unknown");
const evaluatorDriftDetected = Boolean(evaluatorReport.driftDetected);
const adversarialCriticalFindings = Number(adversarialReport?.taxonomy?.criticalFindings ?? 0);
const adversarialWarningFindings = Number(adversarialReport?.taxonomy?.warningFindings ?? 0);
const inferenceStatus = String(inferenceReport?.status ?? "unknown");
const inferenceCriticalCount = Array.isArray(inferenceReport?.drift?.critical) ? inferenceReport.drift.critical.length : 0;
const inferenceWarningCount = Array.isArray(inferenceReport?.drift?.warnings) ? inferenceReport.drift.warnings.length : 0;
const inferenceLintHintCount = Array.isArray(inferenceReport?.lintHints?.ruleHints)
  ? inferenceReport.lintHints.ruleHints.length
  : 0;
const standardsStatus = String(standardsReport?.status ?? "unknown");
const standardsFailureCount = Number(standardsReport?.counts?.failures ?? 0);
const standardsWarningCount = Number(standardsReport?.counts?.warnings ?? 0);

const attentionFlags = [];
if (evaluatorStatus !== "passed") {
  attentionFlags.push(`Evaluator status is '${evaluatorStatus}'`);
}
if (evaluatorDriftDetected) {
  attentionFlags.push("Evaluator driftDetected=true");
}
if (adversarialCriticalFindings > 0) {
  attentionFlags.push(`Adversarial critical findings=${adversarialCriticalFindings}`);
}
if (inferenceStatus !== "aligned") {
  attentionFlags.push(`Inference drift status is '${inferenceStatus}'`);
}
if (inferenceCriticalCount > 0) {
  attentionFlags.push(`Inference critical drift findings=${inferenceCriticalCount}`);
}
if (standardsStatus === "fail" || standardsFailureCount > 0) {
  attentionFlags.push(`Team standards failures=${standardsFailureCount}`);
}

const readinessStatus = attentionFlags.length > 0 ? "attention" : "ready";

const harnessStepsFromStandards = Array.isArray(standardsReport?.harnessResolutionSteps)
  ? standardsReport.harnessResolutionSteps
  : [];

const harnessStepsFromInferenceHints = Array.isArray(inferenceReport?.lintHints?.ruleHints)
  ? inferenceReport.lintHints.ruleHints.flatMap((hint) =>
      Array.isArray(hint?.resolutionSteps) ? hint.resolutionSteps : []
    )
  : [];

const harnessResolutionSteps = uniquePreserveOrder([
  ...harnessStepsFromStandards,
  ...harnessStepsFromInferenceHints
]).slice(0, 12);

if (harnessResolutionSteps.length === 0) {
  harnessResolutionSteps.push(
    "Confirm HAR critical findings are zero before deploy.",
    "Verify timeout, retry budget, and memU policy on every node.",
    "Run replay compare for any run that diverges on verify stage."
  );
}

const now = new Date().toISOString();
const runbookPath = "docs/operations/phase-3-runbook.md";

const metadata = {
  version: 1,
  generatedAt: now,
  generatedBy: "scripts/runbook-drift-check.mjs",
  phase: "phase-3",
  readinessStatus,
  attentionFlags,
  sourceReports: {
    evaluator: String(evaluatorReport.generatedAt ?? "unknown"),
    adversarial: String(adversarialReport.generatedAt ?? "unknown"),
    inference: String(inferenceReport.generatedAt ?? "unknown"),
    teamStandards: String(standardsReport.generatedAt ?? "unknown")
  },
  phase3Features: {
    total: phase3Features.length,
    complete: completePhase3Features.length,
    inProgress: inProgressPhase3Features.length,
    planned: plannedPhase3Features.length
  },
  signals: {
    evaluatorStatus,
    evaluatorDriftDetected,
    adversarialCriticalFindings,
    adversarialWarningFindings,
    inferenceStatus,
    inferenceCriticalCount,
    inferenceWarningCount,
    inferenceLintHintCount,
    standardsStatus,
    standardsFailureCount,
    standardsWarningCount
  }
};

const artifactRows = [
  {
    artifact: "stuck-run-recovery",
    interpretation: "Automatic stale-run recovery was triggered and escalated safely.",
    operatorAction: "Review reason, validate replay eligibility, and either replay or close with operator note."
  },
  {
    artifact: "stuck-run-dead-letter",
    interpretation: "Recovery failed; run moved to dead-letter with replay reference.",
    operatorAction: "Replay from source input using pinned workflow version; inspect cause before re-promote."
  },
  {
    artifact: "replay-bundle-manifest",
    interpretation: "Replay parity baseline metadata is available for deterministic comparison.",
    operatorAction: "Use run compare to confirm parity and inspect divergence taxonomy if parity breaks."
  },
  {
    artifact: "replay-divergence-taxonomy",
    interpretation: "Replay drift categories were detected for the run.",
    operatorAction: "Treat non-zero counts as reliability regression; feed findings into harness remediation."
  },
  {
    artifact: "confidence-gate",
    interpretation: "A stage output fell below confidence threshold and raised needs_human.",
    operatorAction: "Resolve uncertainty with explicit acceptance criteria and replay if necessary."
  },
  {
    artifact: "memory-conflict-latest",
    interpretation: "memU conflict reconciliation recorded dropped/contested memory items.",
    operatorAction: "Review trust/conflict metrics and adjust memory policy or writeback controls."
  }
];

const runbookContent = [
  "# Phase 3 Production Runbook",
  "",
  "<!-- RUNBOOK_METADATA_BEGIN -->",
  JSON.stringify(metadata, null, 2),
  "<!-- RUNBOOK_METADATA_END -->",
  "",
  "## Purpose",
  "",
  "Provide a deterministic on-call and operator flow for Harbor Phase 3 reliability incidents using only repository artifacts and machine-generated reports.",
  "",
  "## Readiness Snapshot",
  "",
  `- Phase tracker status: \`${String(phase3?.status ?? "unknown")}\``,
  `- Phase 3 features complete: \`${completePhase3Features.length}/${phase3Features.length}\``,
  `- Evaluator status: \`${evaluatorStatus}\` (driftDetected=\`${String(evaluatorDriftDetected)}\`)`,
  `- Adversarial findings: critical=\`${adversarialCriticalFindings}\`, warning=\`${adversarialWarningFindings}\``,
  `- Inference drift: status=\`${inferenceStatus}\`, critical=\`${inferenceCriticalCount}\`, warnings=\`${inferenceWarningCount}\`, lintHints=\`${inferenceLintHintCount}\``,
  `- Team standards: status=\`${standardsStatus}\`, failures=\`${standardsFailureCount}\`, warnings=\`${standardsWarningCount}\``,
  `- Runbook readiness: \`${readinessStatus}\``,
  "",
  "## Source Signals",
  "",
  "| Signal | Source | Value |",
  "| --- | --- | --- |",
  `| Evaluator calibration | \`docs/evaluator/reports/latest.json\` | status=\`${evaluatorStatus}\` |`,
  `| Adversarial nightly taxonomy | \`docs/adversarial/reports/latest.json\` | critical=\`${adversarialCriticalFindings}\`, warning=\`${adversarialWarningFindings}\` |`,
  `| Inference drift + suggestions | \`docs/inference/reports/latest.json\` | status=\`${inferenceStatus}\`, critical=\`${inferenceCriticalCount}\` |`,
  `| Team standards encoding | \`docs/team-standards/reports/latest.json\` | status=\`${standardsStatus}\`, failures=\`${standardsFailureCount}\` |`,
  "",
  "## Incident Triage Flow",
  "",
  "1. Confirm scope and identity: tenant, workspace, workflow, run ID.",
  "2. Open run timeline and validate run status transitions (`queued -> running -> completed/needs_human/failed`).",
  "3. Inspect run artifacts from the decision matrix below.",
  "4. If dead-letter or confidence gate exists, replay from source input using pinned workflow version.",
  "5. Run drift and quality gates before promotion:",
  "   - `pnpm runbook:check`",
  "   - `pnpm check`",
  "6. If any critical drift or lint remains, halt deploy/publish and apply Harness Resolution Steps.",
  "",
  "## Run Artifact Decision Matrix",
  "",
  "| Artifact | Interpretation | Operator action |",
  "| --- | --- | --- |",
  ...artifactRows.map((row) => `| \`${row.artifact}\` | ${row.interpretation} | ${row.operatorAction} |`),
  "",
  "## Harness Resolution Steps",
  "",
  ...harnessResolutionSteps.map((step, index) => `${index + 1}. ${step}`),
  "",
  "## Verification Commands",
  "",
  "```bash",
  "pnpm runbook:check",
  "pnpm replay:verify",
  "pnpm features:check",
  "pnpm check",
  "```",
  "",
  "## Escalation and Replay Checklist",
  "",
  "1. Capture escalation reason and attach it to run metadata.",
  "2. Use replay from source input with workflow version pinning.",
  "3. Compare base vs replay run (status, tokens, stage output deltas, artifact deltas).",
  "4. Ensure replay-divergence taxonomy is resolved before promotion.",
  "5. Record post-incident remediations in docs and standards artifacts.",
  "",
  "## Notes",
  "",
  "- This runbook is generated by `scripts/runbook-drift-check.mjs`.",
  "- Do not edit generated sections manually; update source reports/contracts and rerun the gate."
].join("\n");

writeText(runbookPath, `${runbookContent.trimEnd()}\n`);
pass(`Updated generated runbook: ${runbookPath}`);

const runbookText = readText(runbookPath);
const requiredHeadings = [
  "# Phase 3 Production Runbook",
  "## Purpose",
  "## Readiness Snapshot",
  "## Source Signals",
  "## Incident Triage Flow",
  "## Run Artifact Decision Matrix",
  "## Harness Resolution Steps",
  "## Verification Commands",
  "## Escalation and Replay Checklist"
];
for (const heading of requiredHeadings) {
  if (!runbookText.includes(heading)) {
    fail(`Runbook drift: missing heading '${heading}' in ${runbookPath}`);
  } else {
    pass(`Runbook includes heading: ${heading}`);
  }
}

const requiredPhrases = [
  "stuck-run-recovery",
  "stuck-run-dead-letter",
  "replay-bundle-manifest",
  "replay-divergence-taxonomy",
  "confidence-gate",
  "memory-conflict-latest"
];
const normalizedRunbook = runbookText.toLowerCase();
for (const phrase of requiredPhrases) {
  if (!normalizedRunbook.includes(phrase.toLowerCase())) {
    fail(`Runbook drift: missing phrase '${phrase}' in ${runbookPath}`);
  } else {
    pass(`Runbook includes phrase: ${phrase}`);
  }
}

const metadataStart = "<!-- RUNBOOK_METADATA_BEGIN -->";
const metadataEnd = "<!-- RUNBOOK_METADATA_END -->";
const metadataStartIndex = runbookText.indexOf(metadataStart);
const metadataEndIndex = runbookText.indexOf(metadataEnd);
if (metadataStartIndex === -1 || metadataEndIndex === -1 || metadataEndIndex <= metadataStartIndex) {
  fail("Runbook drift: RUNBOOK metadata block is missing or malformed.");
} else {
  const metadataPayload = runbookText.slice(metadataStartIndex + metadataStart.length, metadataEndIndex).trim();
  try {
    const parsed = JSON.parse(metadataPayload);
    if (parsed.readinessStatus !== readinessStatus) {
      fail("Runbook drift: readinessStatus mismatch in generated metadata.");
    } else {
      pass(`Runbook metadata readiness status is ${readinessStatus}`);
    }
  } catch {
    fail("Runbook drift: RUNBOOK metadata block is not valid JSON.");
  }
}

console.log("");
console.log("Runbook Drift Check Summary");
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
console.log("Runbook contract is in sync with Phase 3 artifact signals.");
