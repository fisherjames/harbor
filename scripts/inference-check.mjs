#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const generatedAt = new Date().toISOString();
const mode = (process.env.HARBOR_INFERENCE_GATE_MODE ?? "report").trim().toLowerCase();
const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
const model = (process.env.HARBOR_INFERENCE_MODEL ?? process.env.HARBOR_OPENAI_MODEL ?? "gpt-4.1-mini").trim();
const baseUrl = (process.env.HARBOR_OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
const timeoutMs = parsePositiveInt(process.env.HARBOR_INFERENCE_TIMEOUT_MS, 25_000, 500);
const retries = parsePositiveInt(process.env.HARBOR_INFERENCE_RETRIES, 2, 0);
const retryJitterMs = parsePositiveInt(process.env.HARBOR_INFERENCE_RETRY_JITTER_MS, 150, 0);
const maxCharsPerDocument = parsePositiveInt(process.env.HARBOR_INFERENCE_MAX_CHARS, 6_000, 500);
const inputCostPer1k = parseNumber(process.env.HARBOR_INFERENCE_INPUT_COST_PER_1K, 0.0004);
const outputCostPer1k = parseNumber(process.env.HARBOR_INFERENCE_OUTPUT_COST_PER_1K, 0.0016);

function parsePositiveInt(raw, fallback, minimum) {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return parsed;
}

function parseNumber(raw, fallback) {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

function resolve(relativePath) {
  return path.join(root, relativePath);
}

function readText(relativePath) {
  return fs.readFileSync(resolve(relativePath), "utf8");
}

function readExcerpt(relativePath) {
  const text = readText(relativePath);
  if (text.length <= maxCharsPerDocument) {
    return text;
  }

  const half = Math.floor(maxCharsPerDocument / 2);
  return `${text.slice(0, half)}\n\n... (truncated) ...\n\n${text.slice(-half)}`;
}

function ensureDir(relativePath) {
  fs.mkdirSync(resolve(relativePath), { recursive: true });
}

function writeJson(relativePath, value) {
  fs.writeFileSync(resolve(relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeJsonResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Inference response was empty.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return JSON.parse(fenced[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("Inference response did not contain parseable JSON.");
}

async function backoff(attempt) {
  const baseDelay = 2 ** attempt * 150;
  const jitter = Math.floor(Math.random() * retryJitterMs);
  const delayMs = baseDelay + jitter;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function runChatJson(input) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const endpoint = new URL("chat/completions", normalizedBaseUrl);
  let lastError = new Error("Inference request failed.");

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: input.systemPrompt
            },
            {
              role: "user",
              content: input.userPrompt
            }
          ]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        const requestError = new Error(`OpenAI inference request failed (${response.status}): ${body || "unknown error"}`);
        requestError.retryable = retryable;
        throw requestError;
      }

      const payload = await response.json();
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const firstChoice = choices[0] ?? {};
      const firstMessage = firstChoice.message ?? {};
      const content = typeof firstMessage.content === "string" ? firstMessage.content : "";

      const usage = payload.usage ?? {};
      return {
        json: normalizeJsonResponse(content),
        usage: {
          promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
          completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
          totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0
        }
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const retryable =
        (typeof error === "object" && error !== null && "retryable" in error && Boolean(error.retryable)) ||
        (error instanceof DOMException && error.name === "AbortError") ||
        error instanceof TypeError;

      if (!retryable || attempt >= retries) {
        throw lastError;
      }

      await backoff(attempt);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw lastError;
}

function estimatedCostUsd(tokens) {
  const inputCost = (tokens.promptTokens / 1_000) * inputCostPer1k;
  const outputCost = (tokens.completionTokens / 1_000) * outputCostPer1k;
  return Number((inputCost + outputCost).toFixed(6));
}

function addUsage(target, usage) {
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
}

function normalizeArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function driftPromptPayload() {
  const vision = readExcerpt("docs/strategy/vision.md");
  const gettingStarted = readExcerpt("docs/getting-started.md");
  const features = readExcerpt("docs/features/harness-features.json");
  const agents = readExcerpt("AGENTS.md");

  return {
    systemPrompt:
      "You are Harbor inference drift reviewer. Return strict JSON only with concise findings and action-ready recommendations.",
    userPrompt: [
      "Assess plan/vision drift for Harbor.",
      "Return JSON object with keys:",
      "status: 'aligned' | 'watch' | 'drift'",
      "critical: array of {id,title,detail,evidencePath}",
      "warnings: array of {id,title,detail,evidencePath}",
      "recommendations: array of short imperative strings",
      "Do not include markdown.",
      "Context follows.",
      "--- AGENTS.md ---",
      agents,
      "--- docs/strategy/vision.md ---",
      vision,
      "--- docs/getting-started.md ---",
      gettingStarted,
      "--- docs/features/harness-features.json ---",
      features
    ].join("\n")
  };
}

function lintHintsPromptPayload() {
  const linterRules = readExcerpt("packages/harness/src/rules/core-rules.ts");
  const remediationReport = readExcerpt("docs/team-standards/reports/remediation.json");

  return {
    systemPrompt:
      "You are Harbor harness linter optimizer. Return strict JSON only. Generate practical non-breaking remediation improvements.",
    userPrompt: [
      "Produce inference-assisted remediation hints for Harbor HAR rules.",
      "Return JSON object with keys:",
      "ruleHints: array of {ruleId,hint,resolutionSteps,migrationRisk}",
      "migrationRisk must be one of low|medium|high.",
      "Limit to max 8 hints and prioritize leverage.",
      "Do not include markdown.",
      "Context follows.",
      "--- packages/harness/src/rules/core-rules.ts ---",
      linterRules,
      "--- docs/team-standards/reports/remediation.json ---",
      remediationReport
    ].join("\n")
  };
}

function adversarialPromptPayload() {
  const adversarialSuite = readExcerpt("packages/harness/src/adversarial.ts");
  const fixtures = readExcerpt("docs/adversarial/workflows/nightly-fixtures.json");

  return {
    systemPrompt:
      "You are Harbor adversarial harness designer. Return strict JSON only with realistic attack scenarios and expected controls.",
    userPrompt: [
      "Propose additional adversarial scenarios for Harbor.",
      "Return JSON object with key suggestions: array of {scenarioId,category,severity,attack,expectedDefense}.",
      "category must be one of prompt_injection|tool_permission_escalation|cross_tenant_access|memory_poisoning.",
      "severity must be warning or critical.",
      "Limit to max 8 suggestions and avoid duplicates of existing checks.",
      "Do not include markdown.",
      "Context follows.",
      "--- packages/harness/src/adversarial.ts ---",
      adversarialSuite,
      "--- docs/adversarial/workflows/nightly-fixtures.json ---",
      fixtures
    ].join("\n")
  };
}

function writeHistory(report) {
  ensureDir("docs/inference/reports/history");
  const dateKey = generatedAt.slice(0, 10);
  const historyFile = `docs/inference/reports/history/${dateKey}.json`;
  writeJson(historyFile, report);

  const indexPath = resolve("docs/inference/reports/history/index.json");
  const currentIndex = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, "utf8"))
    : { entries: [] };
  const entries = Array.isArray(currentIndex.entries) ? currentIndex.entries.map(String) : [];
  if (!entries.includes(`${dateKey}.json`)) {
    entries.push(`${dateKey}.json`);
  }

  entries.sort();
  writeJson("docs/inference/reports/history/index.json", { entries });
}

ensureDir("docs/inference/reports");

if (!apiKey) {
  const skippedReport = {
    generatedAt,
    mode,
    status: "skipped",
    skipped: true,
    reason: "OPENAI_API_KEY is not set.",
    generatedBy: "scripts/inference-check.mjs"
  };

  writeJson("docs/inference/reports/latest.json", skippedReport);
  writeHistory(skippedReport);
  console.log("PASS Inference check skipped because OPENAI_API_KEY is not configured.");
  process.exit(0);
}

const usageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0
};

try {
  const driftResult = await runChatJson(driftPromptPayload());
  addUsage(usageTotals, driftResult.usage);

  const lintHintsResult = await runChatJson(lintHintsPromptPayload());
  addUsage(usageTotals, lintHintsResult.usage);

  const adversarialResult = await runChatJson(adversarialPromptPayload());
  addUsage(usageTotals, adversarialResult.usage);

  const drift = {
    status: String(driftResult.json.status ?? "watch"),
    critical: normalizeArray(driftResult.json.critical),
    warnings: normalizeArray(driftResult.json.warnings),
    recommendations: normalizeArray(driftResult.json.recommendations)
  };

  const lintHints = {
    ruleHints: normalizeArray(lintHintsResult.json.ruleHints)
  };

  const adversarial = {
    suggestions: normalizeArray(adversarialResult.json.suggestions)
  };

  const report = {
    generatedAt,
    mode,
    status: drift.status,
    skipped: false,
    provider: "openai",
    model,
    usage: {
      ...usageTotals,
      inputCostPer1k,
      outputCostPer1k,
      estimatedCostUsd: estimatedCostUsd(usageTotals)
    },
    drift,
    lintHints,
    adversarial,
    generatedBy: "scripts/inference-check.mjs"
  };

  writeJson("docs/inference/reports/latest.json", report);
  writeHistory(report);

  const criticalFindings = drift.critical.length;
  const enforce = mode === "enforce";
  if (enforce && (drift.status === "drift" || criticalFindings > 0)) {
    console.log("FAIL Inference gate blocked due to drift findings in enforce mode.");
    process.exit(1);
  }

  console.log("Inference check summary");
  console.log(`- Status: ${drift.status}`);
  console.log(`- Drift critical findings: ${criticalFindings}`);
  console.log(`- Drift warnings: ${drift.warnings.length}`);
  console.log(`- Lint hint suggestions: ${lintHints.ruleHints.length}`);
  console.log(`- Adversarial suggestions: ${adversarial.suggestions.length}`);
  console.log(`- Estimated cost (USD): ${report.usage.estimatedCostUsd}`);
} catch (error) {
  const failureReport = {
    generatedAt,
    mode,
    status: "error",
    skipped: false,
    provider: "openai",
    model,
    error: error instanceof Error ? error.message : String(error),
    generatedBy: "scripts/inference-check.mjs"
  };

  writeJson("docs/inference/reports/latest.json", failureReport);
  writeHistory(failureReport);
  console.error(`FAIL Inference check failed: ${failureReport.error}`);
  process.exit(1);
}
