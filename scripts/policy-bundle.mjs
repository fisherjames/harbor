#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

function usage() {
  console.error("Usage:");
  console.error(
    "  node ./scripts/policy-bundle.mjs sign --document <policy.json> [--policy-version <version>] [--secret <secret>] [--out <bundle.json>]"
  );
  console.error(
    "  node ./scripts/policy-bundle.mjs verify --bundle <bundle.json> [--secret <secret>] [--trusted <sig-a,sig-b>] [--out <result.json>]"
  );
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = new Map();

  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || typeof value !== "string") {
      continue;
    }

    args.set(key.slice(2), value);
    index += 1;
  }

  return {
    command,
    args
  };
}

function readJson(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function writeJson(filePath, value) {
  const absolute = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signPayload(value, secret) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function parseTrustedSignatures(value) {
  if (!value?.trim()) {
    return [];
  }

  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))];
}

function signPolicy(document, policyVersion, secret) {
  const canonicalDocument = stableSerialize(document);
  const checksum = sha256Hex(canonicalDocument);
  const signature = secret ? signPayload(canonicalDocument, secret) : checksum;

  return {
    policyVersion: policyVersion ?? document.version,
    algorithm: "sha256",
    checksum,
    signature,
    document
  };
}

function verifyBundle(bundle, secret, trustedSignatures) {
  const reasons = [];

  if (!bundle || typeof bundle !== "object") {
    reasons.push("Bundle is not a valid JSON object.");
    return { valid: false, reasons };
  }

  if (bundle.algorithm !== "sha256") {
    reasons.push(`Unsupported policy signature algorithm '${String(bundle.algorithm)}'.`);
  }

  if (!bundle.document || typeof bundle.document !== "object") {
    reasons.push("Bundle is missing document payload.");
    return { valid: false, reasons };
  }

  const canonicalDocument = stableSerialize(bundle.document);
  const computedChecksum = sha256Hex(canonicalDocument);
  if (bundle.checksum !== computedChecksum) {
    reasons.push("Policy checksum does not match policy document.");
  }

  if (bundle.policyVersion !== bundle.document.version) {
    reasons.push("policyBundle.policyVersion must match policyBundle.document.version.");
  }

  const expectedSignature = secret ? signPayload(canonicalDocument, secret) : computedChecksum;
  if (bundle.signature !== expectedSignature) {
    reasons.push("Policy signature verification failed.");
  }

  if (trustedSignatures.length > 0 && !trustedSignatures.includes(bundle.signature)) {
    reasons.push("Policy signature is not in trusted signature allow-list.");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    policyVersion: bundle.policyVersion,
    signature: bundle.signature,
    computedChecksum
  };
}

const { command, args } = parseArgs(process.argv.slice(2));
if (!command || (command !== "sign" && command !== "verify")) {
  usage();
  process.exit(1);
}

if (command === "sign") {
  const documentPath = args.get("document");
  if (!documentPath) {
    usage();
    process.exit(1);
  }

  const document = readJson(documentPath);
  const policyVersion = args.get("policy-version");
  const secret = args.get("secret");
  const bundle = signPolicy(document, policyVersion, secret);
  const outputPath = args.get("out");

  if (outputPath) {
    writeJson(outputPath, bundle);
  }

  console.log(JSON.stringify(bundle, null, 2));
  process.exit(0);
}

const bundlePath = args.get("bundle");
if (!bundlePath) {
  usage();
  process.exit(1);
}

const bundle = readJson(bundlePath);
const result = verifyBundle(bundle, args.get("secret"), parseTrustedSignatures(args.get("trusted")));
const outputPath = args.get("out");

if (outputPath) {
  writeJson(outputPath, result);
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.valid ? 0 : 1);
