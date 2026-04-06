#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(
    "Usage: node ./scripts/replay-verify.mjs --manifest <manifest.json> --candidate <candidate.json> [--out <result.json>]"
  );
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || typeof value !== "string") {
      continue;
    }

    args.set(key.slice(2), value);
    index += 1;
  }

  return args;
}

function readJson(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const rendered = entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
  return `{${rendered.join(",")}}`;
}

function compareField(manifest, candidate, field, type, divergences) {
  const left = stableSerialize(manifest[field]);
  const right = stableSerialize(candidate[field]);
  if (left !== right) {
    divergences.push({
      type,
      field,
      expected: manifest[field],
      actual: candidate[field]
    });
  }
}

function buildTaxonomy(divergences) {
  const taxonomy = {
    prompt: 0,
    tool: 0,
    memory: 0,
    model: 0,
    timing: 0,
    policy: 0
  };

  for (const divergence of divergences) {
    if (divergence.type in taxonomy) {
      taxonomy[divergence.type] += 1;
    }
  }

  return taxonomy;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.get("manifest");
const candidatePath = args.get("candidate");
const outPath = args.get("out");

if (!manifestPath || !candidatePath) {
  usage();
  process.exit(1);
}

const manifest = readJson(manifestPath);
const candidate = readJson(candidatePath);

const divergences = [];
compareField(manifest, candidate, "promptEnvelopeHash", "prompt", divergences);
compareField(manifest, candidate, "harnessPolicyHash", "policy", divergences);
compareField(manifest, candidate, "modelSettingsHash", "model", divergences);
compareField(manifest, candidate, "toolPolicyHash", "tool", divergences);
compareField(manifest, candidate, "toolIoHashes", "tool", divergences);
compareField(manifest, candidate, "memoryReadSnapshots", "memory", divergences);
compareField(manifest, candidate, "memoryWriteRefs", "memory", divergences);
compareField(manifest, candidate, "stagePromptHashes", "prompt", divergences);
compareField(manifest, candidate, "policyVersion", "policy", divergences);
compareField(manifest, candidate, "policySignature", "policy", divergences);

const result = {
  parity: divergences.length === 0,
  divergenceCount: divergences.length,
  taxonomy: buildTaxonomy(divergences),
  divergences
};

if (outPath) {
  const absoluteOutPath = path.resolve(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
  fs.writeFileSync(absoluteOutPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.parity ? 0 : 1);
